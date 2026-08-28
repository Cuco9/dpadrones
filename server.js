// D´Padrones — servidor
// Las reglas de diseño están en DECISIONES.md. La que manda aquí: el stock no
// se guarda en ninguna columna, se suma desde la tabla movimientos.

const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const net = require('net');
const tls = require('tls');
const express = require('express');
const Database = require('better-sqlite3');
const certificados = require('./certificados');

const PUERTO = process.env.PUERTO || 3010;
const RUTA_DB = process.env.DP_DB || path.join(__dirname, 'dpadrones.db');

// ─── Base de datos ────────────────────────────────────────────
const db = new Database(RUTA_DB);

function initDB() {
  const esquema = fs.readFileSync(path.join(__dirname, 'db', 'esquema.sql'), 'utf8');
  db.exec(esquema);

  // Datos mínimos para poder arrancar: el almacén principal y el cargo de
  // administrador. Idempotente: si ya existen no se toca nada.
  const ahora = new Date().toISOString();
  const haySitios = db.prepare('SELECT COUNT(*) n FROM sitios').get().n;
  if (haySitios === 0) {
    db.prepare(`INSERT INTO sitios (id, nombre, tipo, padre_id, creado_en, actualizado)
                VALUES (?,?,?,?,?,?)`)
      .run('principal', 'Almacén Principal', 'almacen', null, ahora, ahora);
    console.log('[init] creado el Almacén Principal');
  }
  const hayCargos = db.prepare('SELECT COUNT(*) n FROM cargos').get().n;
  if (hayCargos === 0) {
    db.prepare(`INSERT INTO cargos (id, nombre, permisos, es_admin, creado_en, actualizado)
                VALUES (?,?,?,?,?,?)`)
      .run('admin', 'Administrador', '*', 1, ahora, ahora);
    console.log('[init] creado el cargo Administrador');
  }
  // Migraciones: siempre comprobando antes, siempre sin perder nada. Añadir una
  // columna nueva se hace aquí, no a mano en el servidor (lección de La Inventería).
  const cols = t => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  if (!cols('productos').includes('codigo_barra')) {
    db.exec('ALTER TABLE productos ADD COLUMN codigo_barra TEXT');
    console.log('[migracion] productos: columna codigo_barra añadida');
  }
  // Dos monedas: precio en CUP y precio en USD, puestos a mano. Sin tasa.
  const anadir = (tabla, col, def) => {
    if (!cols(tabla).includes(col)) {
      db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${col} ${def}`);
      console.log('[migracion] ' + tabla + ': columna ' + col + ' añadida');
    }
  };
  anadir('productos', 'precio_moneda', "TEXT NOT NULL DEFAULT 'CUP'");
  anadir('productos', 'foto', 'TEXT');
  anadir('personas', 'recuperacion_hash', 'TEXT');
  anadir('ventas', 'moneda', "TEXT NOT NULL DEFAULT 'CUP'");
  anadir('fondo', 'moneda', "TEXT NOT NULL DEFAULT 'CUP'");
  anadir('dias', 'efectivo_usd', 'REAL NOT NULL DEFAULT 0');
  // Destacado en el sitio web. Vive AQUÍ y no en el sitio porque el catálogo
  // tiene un dueño (DECISIONES.md #3): si se marcara en el sitio, la siguiente
  // publicación lo borraría, que reemplaza el catálogo entero.
  anadir('productos', 'destacado', 'INTEGER NOT NULL DEFAULT 0');
  // El cambio del día, congelado en cada venta. Las ventas de antes se quedan
  // con 0: para esas se usa el valor del dólar de hoy, que es lo único que hay.
  anadir('ventas', 'tasa', 'REAL NOT NULL DEFAULT 0');
  // En qué moneda se le paga a cada trabajador. La comisión se MIDE en la
  // moneda del negocio, como todo lo demás, pero cobrarla es otra cosa: aquí
  // hay quien cobra en dólares y quien cobra en pesos, y esa cuenta la hacía
  // alguien a mano a fin de mes. Vacío = en la moneda del negocio.
  anadir('personas', 'moneda_pago', 'TEXT');

  // Anular un apunte del fondo apuntado a mano. No se borra la fila: se mete
  // otra que apunta a ella y la deja en cero (DECISIONES.md #2 y #31). Sin esta
  // columna no habría forma de saber cuál corrige a cuál, ni de esconder el par
  // de la lista.
  anadir('fondo', 'anula_a', 'TEXT');

  // La baja de un cargo. Se apunta, no se borra la fila: una fila que
  // desaparece no viaja a ninguna parte, así que al juntarse dos copias el
  // cargo borrado volvería del otro lado (DECISIONES.md #31). Es la misma
  // lápida que ya llevan los artículos de la web.
  anadir('cargos', 'borrado_en', 'TEXT');

  // A QUIÉN se le paga, cuando el apunte es el pago de una comisión. Columna
  // aparte y no 'persona_id' a propósito: esa ya significa otra cosa —quién
  // apuntó el movimiento—, y la ficha de un apunte la enseña como «Registrado
  // por». Metiendo ahí al trabajador, la ficha del pago diría que lo registró la
  // persona que lo cobró, que es exactamente el tipo de nombre reutilizado que
  // ha costado tres fallos en esta aplicación.
  anadir('fondo', 'beneficiario_id', 'TEXT');

  // Si este apunte es DINERO PARA LA GENTE: un salario, un adelanto, el pago de
  // una comisión. Hace falta para poder restarlo de la ganancia en los desgloses
  // (DECISIONES.md #33). Preguntado por el dueño el 17 de agosto de 2026: «cuando
  // se habla de ganancias, ¿se está teniendo en cuenta restar las comisiones y
  // salarios?». No se estaba.
  //
  // Es una columna y no una lista de palabras porque el subtipo lo escribe la
  // persona: hoy hay «Salarios», «Salario de jefe» y «salario», y mañana habrá
  // «pago a los muchachos». Adivinar por el texto es exactamente lo que ya ha
  // fallado tres veces en esta aplicación.
  anadir('fondo', 'es_gente', 'INTEGER NOT NULL DEFAULT 0');

  // Por quién se está haciendo pasar el administrador en esta sesión (#35). Vive
  // en la sesión y no en el dispositivo: si viviera allí, bastaría con dejar de
  // mandar el dato para recuperar los permisos de administrador.
  anadir('sesiones', 'como_persona_id', 'TEXT');

  // DÓNDE valen los permisos de un cargo (DECISIONES.md #35). Preguntado por el
  // dueño: «¿se puede crear un rol que sí tenga permiso en varias tiendas y
  // almacenes? al crear un rol se decide dónde tendrá sus permisos, en qué local».
  //
  //   'propio' — en el local que tenga puesto cada persona. Es lo que valía hasta
  //              ahora, y por eso es el valor por defecto: ningún cargo cambia de
  //              comportamiento al desplegar esto.
  //   'lista'  — en los locales marcados en el cargo ('sitios', separados por coma).
  //   'todos'  — en todos, sin límite.
  //
  // El alcance va en el CARGO y el local de cada uno en la PERSONA, y las dos cosas
  // hacen falta: con el alcance solo en el cargo, un «Vendedor · Tienda Centro» no
  // serviría para el vendedor de otra tienda y habría que duplicar el cargo entero,
  // con sus cuarenta permisos, y mantener las copias iguales a mano para siempre.
  anadir('cargos', 'alcance', "TEXT NOT NULL DEFAULT 'propio'");
  anadir('cargos', 'sitios', 'TEXT');

  // (La migración de los permisos de cada cargo NO puede ir aquí: el catálogo
  //  PERMISOS se declara mucho más abajo y desde initDB() todavía no existe.
  //  Está en migrarPermisos(), justo después de esa lista.)

  // Y lo ya apuntado hay que marcarlo, o el mes en curso saldría diciendo que no
  // se ha pagado un salario en la vida. Esto SÍ mira el texto, y es correcto que
  // lo haga: es una lectura de lo que ya está escrito, no una regla que se quede
  // en el código decidiendo el futuro.
  //
  // Corre UNA VEZ, y la marca en 'ajustes' es lo que lo garantiza. Sin ella
  // volvería a pasar en cada reinicio, y entonces un apunte que el dueño hubiera
  // decidido NO contar como pago a la gente —porque la palabra «comisión» sale en
  // el concepto por otro motivo— se volvería a marcar solo cada vez que se
  // reinicia el servidor, sin que nadie entendiera por qué.
  if (!ajuste('marcado_es_gente')) {
    const marcados = db.prepare(`UPDATE fondo SET es_gente=1
        WHERE tipo IN ('retiro','gasto')
          AND (LOWER(COALESCE(subtipo,'')) LIKE '%salari%'
            OR LOWER(COALESCE(subtipo,'')) LIKE '%comisi%'
            OR LOWER(COALESCE(concepto,'')) LIKE '%salari%'
            OR LOWER(COALESCE(concepto,'')) LIKE '%comisi%')`).run();
    // Con new Date() y no con ahoraISO(): initDB() corre antes de que esa
    // constante exista, y llamarla aquí tumba el arranque entero.
    ajuste('marcado_es_gente', new Date().toISOString());
    console.log('[migracion] ' + marcados.changes +
      ' apunte(s) de dinero marcados como pago a la gente');
  }

  // De qué gaveta sale el dinero de la inversión. Se trajo del botón
  // «Inversión» del fondo, que se quitó por hacer solo la mitad: era lo único
  // que ese botón sabía hacer y la inversión no.
  anadir('inversiones', 'sitio_id', 'TEXT');

  // Y una línea de inversión puede no llevar producto: el transporte, un
  // ayudante o la comida de la obra son dinero con un concepto, no mercancía.
  // La columna era NOT NULL, y eso en SQLite no se cambia con un ALTER: hay que
  // rehacer la tabla. Se hace con las claves ajenas apagadas y dentro de una
  // transacción, que es la forma documentada; si algo fallara, no queda a
  // medias. Se comprueba antes, así que arrancar dos veces no la rehace dos
  // veces.
  if (!cols('inversion_lineas').includes('descripcion')) {
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(`CREATE TABLE inversion_lineas_nueva (
            id           TEXT PRIMARY KEY,
            inversion_id TEXT NOT NULL REFERENCES inversiones(id),
            producto_id  TEXT REFERENCES productos(id),
            descripcion  TEXT,
            cantidad     REAL NOT NULL,
            costo_unit   REAL NOT NULL DEFAULT 0,
            orden        INTEGER NOT NULL DEFAULT 0
          );
          INSERT INTO inversion_lineas_nueva
            (id, inversion_id, producto_id, descripcion, cantidad, costo_unit, orden)
            SELECT id, inversion_id, producto_id, NULL, cantidad, costo_unit, orden
            FROM inversion_lineas;
          DROP TABLE inversion_lineas;
          ALTER TABLE inversion_lineas_nueva RENAME TO inversion_lineas;
          CREATE INDEX IF NOT EXISTS idx_inv_lineas ON inversion_lineas(inversion_id);`);
      })();
      console.log('[migracion] inversion_lineas: ahora admite líneas sin producto');
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }

  // Los «proyectos» del 12 de agosto duraron unas horas: el cliente explicó
  // mejor lo que quería y salieron las inversiones con su lista de productos,
  // que es otra cosa. Nunca llegaron a ningún aparato, así que se quitan en vez
  // de dejar dos tablas muertas que además viajarían en cada sincronización.
  for (const vieja of ['proyecto_enlaces', 'proyectos']) {
    const hay = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(vieja);
    if (hay) { db.exec('DROP TABLE ' + vieja); console.log('[migracion] quitada la tabla ' + vieja); }
  }

  console.log('✓ Base de datos lista:', RUTA_DB);
}
initDB();

// ─── SALVAS: copias de seguridad, solas ───────────────────────
// La aplicación vive en una máquina de un local, sin nadie que la cuide. Si ese
// disco se rompe o alguien borra el archivo, se pierde el negocio entero: el
// inventario, las ventas, las cuentas. Por eso se salva sola, sin que nadie
// tenga que acordarse.
//
// Se usa el copiado en caliente de SQLite (db.backup), que saca una copia
// entera y coherente aunque justo en ese momento se esté cobrando algo. Copiar
// el archivo con el explorador mientras la app trabaja puede dar una copia rota
// que parece buena hasta el día que hace falta.
const RUTA_SALVAS = process.env.DP_SALVAS || path.join(__dirname, 'salvas');
const SALVAS_CADA = Number(process.env.DP_SALVAS_CADA || 6);      // horas
const SALVAS_GUARDAR = Number(process.env.DP_SALVAS_GUARDAR || 30);

function listarSalvas() {
  try {
    return fs.readdirSync(RUTA_SALVAS)
      .filter(f => /^dp-\d{8}-\d{4}\.db$/.test(f))
      .map(f => {
        const st = fs.statSync(path.join(RUTA_SALVAS, f));
        return { archivo: f, bytes: st.size, cuando: st.mtime.toISOString() };
      })
      .sort((a, b) => a.archivo < b.archivo ? 1 : -1);
  } catch (e) { return []; }
}

async function salvar(motivo) {
  fs.mkdirSync(RUTA_SALVAS, { recursive: true });
  const t = new Date();
  const sello = t.toISOString().slice(0, 10).replace(/-/g, '') + '-' +
                String(t.getHours()).padStart(2, '0') + String(t.getMinutes()).padStart(2, '0');
  const destino = path.join(RUTA_SALVAS, 'dp-' + sello + '.db');
  await db.backup(destino);
  // Se guardan las últimas y se tiran las viejas. Sin esto, un disco pequeño se
  // llena en unos meses y las salvas empiezan a fallar justo cuando hacen falta.
  const sobran = listarSalvas().slice(SALVAS_GUARDAR);
  for (const s of sobran) { try { fs.unlinkSync(path.join(RUTA_SALVAS, s.archivo)); } catch (e) {} }
  console.log('[salva] ' + path.basename(destino) +
              (motivo ? ' (' + motivo + ')' : '') + ' — ' + listarSalvas().length + ' guardadas');
  return path.basename(destino);
}

// ─── Ayudas ───────────────────────────────────────────────────
const ahoraISO = () => new Date().toISOString();
const nuevoId = () => require('crypto').randomUUID();
// Los interrogantes de un «IN (?,?,?)». Se arman por cuenta, nunca pegando
// valores dentro del SQL.
const huecos = n => new Array(n).fill('?').join(',');

// El código correlativo lo genera SOLO el servidor, y solo el administrador crea
// productos (DECISIONES.md #3). Por eso no puede repetirse aunque los puntos
// estén sin internet: si varios aparatos pudieran crear catálogo, dos productos
// distintos nacerían con el mismo código y sería muy feo de deshacer.
function siguienteCodigo() {
  const fila = db.prepare(
    `SELECT codigo FROM productos WHERE codigo LIKE 'DP-%'
     ORDER BY CAST(SUBSTR(codigo,4) AS INTEGER) DESC LIMIT 1`).get();
  const n = fila ? parseInt(fila.codigo.slice(3), 10) + 1 : 1;
  return 'DP-' + String(n).padStart(4, '0');
}

// La foto llega ya encogida desde el aparato. Aquí solo se pone un techo: una
// imagen enorme engordaría la base de datos y, sobre todo, cada paquete de
// sincronización que viaje por WhatsApp.
const FOTO_MAX = 400000;   // ~400 KB de texto base64
function revisarFoto(f) {
  if (f === undefined) return null;
  if (!f) return null;
  const s = String(f);
  if (!s.startsWith('data:image/')) return null;
  if (s.length > FOTO_MAX) return false;
  return s;
}

// El catálogo, SIN LAS FOTOS. Medido en la base del negocio el 17 de agosto de
// 2026: 37 de 60 productos con foto, **1 962 KB en total**. Eso viajaba dentro del
// JSON del catálogo en cada arranque de la aplicación y después de cada venta, por
// el internet de un teléfono, antes de que se viera un solo precio. Era la razón
// por la que la aplicación tardaba en mostrar los productos.
//
// Ahora va solo si HAY foto y con qué fecha, y la imagen se pide por su propia
// dirección (más abajo), donde el navegador la guarda y no vuelve a viajar. El
// catálogo baja de ~2 MB a unos pocos KB.
//
// El 'SELECT *' de antes es justo lo que lo escondía: la columna se añadió después
// y se colaba en la respuesta sin que nadie tuviera que escribirla.
const CAMPOS_PRODUCTO = `id, codigo, codigo_barra, nombre, categoria, um, costo,
  costo_repo, precio, precio_moneda, comision, comision_pct, stock_min, destacado,
  creado_en, actualizado,
  (foto IS NOT NULL) tiene_foto`;

function productosConPrecios() {
  const productos = db.prepare(
    `SELECT ${CAMPOS_PRODUCTO} FROM productos WHERE borrado_en IS NULL ORDER BY nombre`).all();
  const precios = db.prepare('SELECT * FROM precios_sitio').all();
  const porProducto = {};
  precios.forEach(p => (porProducto[p.producto_id] = porProducto[p.producto_id] || []).push(p));
  productos.forEach(p => { p.precios = porProducto[p.id] || []; });
  return productos;
}

function guardarPreciosSitio(productoId, precios) {
  if (!Array.isArray(precios)) return;
  const borrar = db.prepare('DELETE FROM precios_sitio WHERE producto_id=? AND sitio_id=?');
  const poner = db.prepare(`INSERT INTO precios_sitio (producto_id, sitio_id, precio, actualizado)
     VALUES (?,?,?,?) ON CONFLICT(producto_id, sitio_id)
     DO UPDATE SET precio=excluded.precio, actualizado=excluded.actualizado`);
  const ahora = ahoraISO();
  for (const p of precios) {
    if (!p || !p.sitio_id) continue;
    if (p.precio == null || !(Number(p.precio) > 0)) borrar.run(productoId, p.sitio_id);
    else poner.run(productoId, p.sitio_id, Number(p.precio), ahora);
  }
}

// ─── App ──────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// El sello del negocio, también con el candado puesto: así, desde un aparato ya
// preparado se le puede pasar el enlace a otro sin tener que explicar puertos.
app.get('/sello-del-negocio.crt', (req, res) => {
  if (!fs.existsSync(certificados.ARCHIVOS.caCrt)) return res.status(404).end();
  res.set('Content-Type', 'application/x-x509-ca-cert')
     .set('Content-Disposition', 'attachment; filename="sello-del-negocio.crt"')
     .send(fs.readFileSync(certificados.ARCHIVOS.caCrt));
});
// La foto de un producto, por su propia dirección y con caché de un año. Es lo que
// saca los 2 MB de fotos del arranque de la aplicación.
//
// Va FUERA de /api a propósito: una etiqueta <img> no manda la cabecera del token,
// así que dentro de /api habría que meter el token en la dirección de cada imagen —
// y entonces quedaría escrito en el historial del navegador y en los registros del
// servidor, que es justo lo que este archivo evita en todo lo demás.
//
// Que no pida sesión es aceptable y no abre nada nuevo: es una foto de mercancía, el
// mismo dato que el sitio web publica en internet para cualquiera, y no lleva
// precios, costos ni existencias. Hace falta el identificador del producto, que es
// un UUID: no se puede ir probando números para ver el catálogo.
//
// La dirección lleva '?v=' con la fecha de la última edición. Así la caché puede ser
// eterna —la imagen de esa versión no cambia nunca— y al cambiar la foto cambia la
// dirección, que es lo que hace que el teléfono se entere.
app.get('/foto-producto/:id', (req, res) => {
  const p = db.prepare('SELECT foto FROM productos WHERE id=?').get(String(req.params.id));
  if (!p || !p.foto) return res.status(404).end();
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(p.foto);
  if (!m) return res.status(404).end();
  const bytes = Buffer.from(m[2], 'base64');
  res.set('Content-Type', m[1])
     .set('Cache-Control', 'public, max-age=31536000, immutable')
     .set('Content-Length', bytes.length)
     .send(bytes);
});

app.get('/sello', (req, res) => {
  if (!fs.existsSync(certificados.ARCHIVOS.caCrt)) return res.status(404).end();
  const pem = fs.readFileSync(certificados.ARCHIVOS.caCrt, 'utf8');
  res.send(certificados.paginaDeInstalacion({ destino: '/', huella: certificados.huellaDePem(pem) }));
});

// ─── Puerta de entrada ────────────────────────────────────────
// Todo lo que hay bajo /api pide sesión, menos el estado y el propio login.
// Ojo: dentro de app.use('/api', ...) la ruta llega SIN el prefijo /api.
const LIBRES = ['/salud', '/marca', '/auth/estado', '/auth/entrar', '/auth/crear-admin',
                '/auth/recuperar'];
app.use('/api', (req, res, next) => {
  // Normalmente el token va en la cabecera. En una DESCARGA no se puede poner
  // cabecera —la pide el navegador solo—, así que ahí se admite en la
  // dirección. Solo para descargar: en cualquier otro sitio quedaría escrito en
  // el historial del navegador y en los registros del servidor.
  const enLaURL = req.method === 'GET' && /^\/salvas\//.test(req.path)
    ? String(req.query.token || '') : '';
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || enLaURL;
  if (token) {
    // 'p.*' NO trae las columnas de la sesión: hay que pedir a mano cada una que
    // haga falta. La de abajo se olvidó al añadirla y el «ver como» contestaba que
    // sí a todo sin aplicar nada, que es la peor forma de fallar: sin error.
    const s = db.prepare(`SELECT s.persona_id, s.como_persona_id, p.* FROM sesiones s
        JOIN personas p ON p.id=s.persona_id WHERE s.token=? AND p.activo=1`).get(token);
    if (s) {
      req.persona = s;
      req.permisos = permisosDe(s);
      req.token = token;
      db.prepare('UPDATE sesiones SET ultimo_uso=? WHERE token=?').run(ahoraISO(), token);

      // ── HACERSE PASAR POR UN TRABAJADOR (DECISIONES.md #35) ──
      // Pedido por el dueño el 17 de agosto de 2026: «el admin tiene la opción de
      // ver la aplicación como lo haría ese trabajador con su rol y sus permisos y
      // puede hacer lo mismo que él, porque no tengo claro lo que quiero que haga
      // cada trabajador».
      //
      // DOS IDENTIDADES, y no se confunden nunca:
      //   · req.persona sigue siendo QUIEN FIRMA. Lo que se apunte queda a su
      //     nombre, porque el registro no puede mentir sobre quién hizo qué.
      //   · req.comoPersona es DE QUIÉN SON LOS PERMISOS y el sitio. Es lo que
      //     decide qué se puede hacer.
      //
      // Se guarda en la sesión y no en la pantalla: si viviera en el teléfono,
      // bastaría con no mandar el dato para recuperar los permisos de
      // administrador, y entonces esto no sería «ver como él» sino un adorno.
      if (s.como_persona_id) {
        const otro = db.prepare('SELECT * FROM personas WHERE id=? AND activo=1')
          .get(s.como_persona_id);
        // Solo un administrador puede estar en la piel de otro. Se vuelve a
        // comprobar en CADA petición: si mientras está dentro alguien le quita el
        // cargo de administrador, deja de poder al momento.
        if (otro && req.permisos.includes('*')) {
          req.comoPersona = otro;
          req.permisos = permisosDe(otro);
        } else {
          db.prepare('UPDATE sesiones SET como_persona_id=NULL WHERE token=?').run(token);
        }
      }
    }
  }
  if (LIBRES.includes(req.path) || req.persona) return next();
  res.status(401).json({ error: 'Hay que entrar con tu usuario' });
});

// ─── CADA UNO EN SU SITIO (DECISIONES.md #35) ──────────────────
// Pedido por el dueño: «un trabajador de la tienda solo tendrá permisos permitidos
// dentro de esa tienda, no podrá tocar más nada que sea de otro sitio».
//
// Hasta ahora NINGÚN permiso miraba el sitio: el sitio viaja en la petición y
// nadie lo comprobaba, así que un vendedor de una tienda podía vender en el
// almacén, apuntar mermas en otro punto y cerrar la jornada de otra tienda. Y no
// se notaba, porque en la pantalla solo se veía su sitio: bastaba con cambiar el
// dato de la petición.
//
// Va en un middleware y no endpoint por endpoint a propósito. Son más de cuarenta
// puertas que llevan un sitio, y la que se olvide es justo la que deja pasar. Aquí
// se comprueba TODO lo que llegue con nombre de sitio, en la dirección o en el
// cuerpo, sea de quien sea.
//
// Quien no tiene sitio en su ficha («Cualquiera») no se ve afectado: es el caso
// del dueño y del almacenero que mira el negocio entero.
// Lo que se hace en la piel de otro queda apuntado. La venta se guarda a nombre de
// quien firma —el registro no puede mentir sobre quién la hizo— y esto contesta la
// otra pregunta: por qué el jefe apuntó algo a las once de la noche. Solo lo que
// escribe: mirar pantallas no cambia nada.
app.use('/api', (req, res, next) => {
  if (req.comoPersona && req.method !== 'GET')
    db.prepare(`INSERT INTO actuaciones (id,persona_id,como_id,metodo,ruta,creado_en)
                VALUES (?,?,?,?,?,?)`)
      .run(nuevoId(), req.persona.id, req.comoPersona.id, req.method,
           String(req.path).slice(0, 120), ahoraISO());
  next();
});

// En qué locales valen los permisos de quien pide. Devuelve null si valen en
// todos, o un Set de ids si están limitados. Lo decide el CARGO —su alcance— y,
// cuando el alcance es «el suyo», el local que tenga puesta la persona.
function sitiosDe(req) {
  if (!req.persona) return null;
  if (req.permisos && req.permisos.includes('*')) return null;    // el administrador, en todos
  const quien = req.comoPersona || req.persona;
  const cargo = db.prepare('SELECT alcance, sitios FROM cargos WHERE id=?').get(quien.cargo_id);
  const alcance = (cargo && cargo.alcance) || 'propio';
  if (alcance === 'todos') return null;
  if (alcance === 'lista') {
    const lista = String((cargo && cargo.sitios) || '').split(',').map(s => s.trim()).filter(Boolean);
    // Un cargo marcado «estos locales» y sin ninguno marcado no vale en ninguno.
    // Es lo correcto: lo contrario —valer en todos— sería justo lo que se quiso
    // evitar al elegir esa opción, y nadie lo notaría.
    return new Set(lista);
  }
  // 'propio': el local de la persona. Sin local puesto («Cualquiera»), todos: es el
  // caso del dueño y del almacenero que mira el negocio entero.
  return quien.sitio_id ? new Set([quien.sitio_id]) : null;
}

// Y en qué locales puede MIRAR. Es otra pregunta que la de arriba: aquella dice
// dónde puede TOCAR, y esta dónde puede ver (DECISIONES.md #39).
//
// El permiso «Ver TODOS los sitios, no solo el suyo» es lo único que abre la
// puerta al negocio entero. Sin él, quien está asignado a una tienda ve el
// dinero, el resumen y las cuentas DE ESA TIENDA: ni el fondo general, ni las
// cajas de las demás. Antes era todo o nada —o no veía nada, o lo veía todo—, y
// eso dejaba al dueño sin forma de poner a alguien al frente de un solo local.
function sitiosQueVe(req) {
  if (puede(req, 'ver_negocio_entero')) return null;
  return sitiosDe(req);
}

// Lo mismo, en forma de lista para meter en un IN. Null = no hay que filtrar.
// Un cargo marcado «estos locales» y sin ninguno marcado no ve ninguno: se filtra
// por un id que no existe, que es exactamente lo que significa. Devolver una lista
// vacía sería no filtrar, o sea enseñarlo todo.
function idsQueVe(req) {
  const s = sitiosQueVe(req);
  if (!s) return null;
  return s.size ? [...s] : ['ninguno'];
}

// El saldo que le toca ver a quien pregunta: el del negocio entero, o la suma de
// sus cajas. Va aquí porque lo contestan media docena de puertas al terminar de
// apuntar algo («quedan 1 200»), y esa cifra no puede ser la del negocio entero
// para quien no puede verlo.
function saldoVisible(req) {
  const suyos = sitiosQueVe(req);
  if (!suyos) return saldoFondo();
  const r = { CUP: 0, USD: 0 };
  for (const s of suyos) {
    const g = saldoFondo(s);
    r.CUP += g.CUP; r.USD += g.USD;
  }
  return r;
}

const CAMPOS_DE_SITIO = ['sitio_id', 'sitio', 'origen_id', 'destino_id',
                         'desde_sitio', 'hasta_sitio'];
app.use('/api', (req, res, next) => {
  const suyos = sitiosDe(req);
  if (!suyos) return next();                      // vale en todos los locales
  if (req.permisos && req.permisos.includes('ver_negocio_entero') && req.method === 'GET')
    return next();                                // puede MIRAR todo, pero no escribir fuera
  const nombres = db.prepare('SELECT id, nombre FROM sitios').all();
  const nombreDe = id => (nombres.find(s => s.id === id) || {}).nombre || 'otro sitio';
  const losSuyos = [...suyos].map(nombreDe).join(' y ') || 'ningún local';
  const mirar = (fuente) => {
    for (const campo of CAMPOS_DE_SITIO) {
      const v = fuente && fuente[campo];
      if (v && typeof v === 'string' && !suyos.has(v) && nombres.some(s => s.id === v)) return v;
    }
    return null;
  };
  const ajeno = mirar(req.query) || mirar(req.body);
  if (ajeno) return res.status(403).json({
    error: 'Tú trabajas en ' + losSuyos + ', así que no puedes tocar nada de ' +
           nombreDe(ajeno) + '.', sitio_ajeno: ajeno });
  // Una línea puede llevar su propio sitio, y ahí también hay que mirar: si no,
  // se podría sacar mercancía del almacén escribiéndola en una línea.
  for (const l of (Array.isArray(req.body && req.body.lineas) ? req.body.lineas : [])) {
    const s = l && l.sitio_id;
    if (s && !suyos.has(s) && nombres.some(x => x.id === s)) return res.status(403).json({
      error: 'Una línea saca material de ' + nombreDe(s) + ', y tú trabajas en ' +
             losSuyos + '.', sitio_ajeno: s });
  }
  next();
});

// ─── IDENTIDAD DEL NEGOCIO ────────────────────────────────────
// Se sirve sin pedir sesión: la pantalla de entrar necesita el logo y el
// nombre ANTES de que nadie haya entrado.
// Los datos de contacto del negocio, que salen en el pie de los informes que
// se imprimen. Vienen vacíos y se escriben en Ajustes → La empresa: el día que
// cambie el teléfono, eso no puede depender de que alguien toque el código y
// despliegue.
const POR_DEFECTO = {
  direccion: '',
  telefono: '',
  correo: ''
};
function marca() {
  const m = {
    nombre: ajuste('negocio_nombre') || 'D´Padrones',
    lema: ajuste('negocio_lema') || '',
    logo: ajuste('negocio_logo') || null
  };
  // Un campo vacío a propósito (por ejemplo, borrar el teléfono) se respeta: se
  // guarda la cadena vacía y solo se pone lo de fábrica si nunca se tocó.
  for (const k in POR_DEFECTO) {
    const v = ajuste('negocio_' + k);
    m[k] = v === null || v === undefined ? POR_DEFECTO[k] : v;
  }
  return m;
}
app.get('/api/marca', (req, res) => res.json(marca()));
app.post('/api/marca', exige('mi_empresa'), (req, res) => {
  const b = req.body || {};
  if (b.nombre !== undefined) ajuste('negocio_nombre', String(b.nombre).trim().slice(0, 60));
  if (b.lema !== undefined) ajuste('negocio_lema', String(b.lema).trim().slice(0, 80));
  if (b.logo !== undefined) {
    const f = revisarFoto(b.logo);
    if (f === false) return res.status(400).json({ error: 'El logo es demasiado grande' });
    ajuste('negocio_logo', f || '');
  }
  // Los datos del certificado de garantía. Se recortan por si acaso, pero no se
  // exige ninguno: una empresa puede no tener web, y quedarse sin poder guardar
  // los otros nueve campos por eso sería absurdo.
  for (const k in POR_DEFECTO) {
    if (b[k] === undefined) continue;
    const tope = k === 'direccion' ? 200 : k === 'garantia_meses' ? 3 : 90;
    ajuste('negocio_' + k, String(b[k]).trim().slice(0, tope));
  }
  res.json(Object.assign({ ok: true }, marca()));
});

// ─── CLAVE DE RECUPERACIÓN ────────────────────────────────────
// El administrador no tiene a nadie por encima que le devuelva el PIN, así que
// se le da una clave al crearlo. Los trabajadores no la necesitan: a ellos les
// cambia el PIN el administrador desde Ajustes, que es como debe ser.
function nuevaClaveRecuperacion() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // sin I, O, 0, 1: se confunden al copiar
  const trozo = () => Array.from({ length: 4 },
    () => abc[crypto.randomInt(abc.length)]).join('');
  return trozo() + '-' + trozo() + '-' + trozo();
}

app.post('/api/auth/recuperar', (req, res) => {
  const b = req.body || {};
  const usuario = String(b.usuario || '').trim().toLowerCase();
  const espera = frenado('rec|' + usuario);
  if (espera) return res.status(429).json({
    error: 'Demasiados intentos. Espera ' + Math.ceil(espera / 60) + ' minuto(s).' });
  const p = db.prepare('SELECT * FROM personas WHERE usuario=? AND activo=1').get(usuario);
  const clave = String(b.clave || '').trim().toUpperCase();
  if (!p || !p.recuperacion_hash || !pinCorrecto(clave, p.recuperacion_hash)) {
    fallo('rec|' + usuario);
    return res.status(401).json({ error: 'Usuario o clave de recuperación incorrectos' });
  }
  if (!pinValido(b.pin)) return res.status(400).json({ error: PIN_MAL });
  intentos.delete('rec|' + usuario);
  // La clave usada se quema y se da una nueva: si alguien la vio por encima del
  // hombro, deja de servir en cuanto se usa.
  const nueva = nuevaClaveRecuperacion();
  db.prepare('UPDATE personas SET pin_hash=?, recuperacion_hash=?, actualizado=? WHERE id=?')
    .run(hashPin(b.pin), hashPin(nueva), ahoraISO(), p.id);
  db.prepare('DELETE FROM sesiones WHERE persona_id=?').run(p.id);   // fuera las sesiones viejas
  res.json({ ok: true, clave_nueva: nueva });
});

// ─── CAMBIARSE EL PIN UNO MISMO ───────────────────────────────
// Hasta ahora el PIN de un trabajador solo lo podía cambiar el administrador, y
// aquí arriba está escrito que «es como debe ser». El dueño pidió lo contrario y
// tiene razón práctica: el PIN se lo pone el administrador al crear la cuenta,
// así que hay un rato en el que DOS personas conocen la llave de un usuario. Que
// cada uno se ponga el suyo en cuanto entra cierra ese rato.
//
// Hace falta el PIN de ahora. Sin eso, un teléfono desbloqueado que alguien deje
// encima del mostrador es una cuenta regalada: cualquiera le pondría otro PIN y
// el dueño de la cuenta se quedaría fuera sin saber por qué.
//
// El administrador sigue pudiendo cambiárselo a cualquiera desde Personal, que
// es lo que hace falta cuando alguien lo olvida de verdad.
app.post('/api/auth/mi-pin', (req, res) => {
  const b = req.body || {};
  const yo = req.persona;
  // El mismo freno del login, con su propia etiqueta. Con la del login, cinco
  // pruebas aquí dejarían a esa persona sin poder ENTRAR en la aplicación, que
  // es un castigo que no toca.
  const etiqueta = 'mipin|' + yo.id;
  const espera = frenado(etiqueta);
  if (espera) return res.status(429).json({
    error: 'Demasiados intentos. Espera ' + Math.ceil(espera / 60) + ' minuto(s).' });
  if (!pinCorrecto(b.pin_actual, yo.pin_hash)) {
    fallo(etiqueta);
    return res.status(401).json({ error: 'El PIN de ahora no es correcto' });
  }
  if (!pinValido(b.pin_nuevo)) return res.status(400).json({ error: PIN_MAL });
  if (String(b.pin_nuevo) === String(b.pin_actual))
    return res.status(400).json({ error: 'Ese es el PIN que ya tenías puesto.' });
  intentos.delete(etiqueta);
  // 'actualizado' se pone a mano: es la columna por la que el cambio VIAJA a los
  // demás aparatos. Sin ella, el PIN nuevo se quedaría en esta copia y en la de
  // al lado seguiría valiendo el viejo (DECISIONES.md #11).
  db.prepare('UPDATE personas SET pin_hash=?, actualizado=? WHERE id=?')
    .run(hashPin(b.pin_nuevo), ahoraISO(), yo.id);
  // Fuera las demás sesiones suyas, y SOLO las demás: la sesión de aquí se
  // queda, o cambiarse el PIN te echaría de la aplicación en ese mismo momento.
  const fuera = db.prepare('DELETE FROM sesiones WHERE persona_id=? AND token<>?')
    .run(yo.id, req.token || '').changes;
  if (fuera) console.log('[personas] ' + yo.usuario + ' se cambió el PIN: ' +
                         fuera + ' sesión(es) cerradas');
  res.json({ ok: true, sesiones_cerradas: fuera });
});

// Volver a generar la clave, estando dentro
app.post('/api/auth/nueva-clave', (req, res) => {
  const clave = nuevaClaveRecuperacion();
  db.prepare('UPDATE personas SET recuperacion_hash=?, actualizado=? WHERE id=?')
    .run(hashPin(clave), ahoraISO(), req.persona.id);
  res.json({ ok: true, clave });
});

// ¿Hay administrador todavía? La primera vez que se abre la app, no.
app.get('/api/auth/estado', (req, res) => {
  const n = db.prepare('SELECT COUNT(*) n FROM personas WHERE activo=1').get().n;
  res.json({ hay_admin: n > 0, permisos_posibles: PERMISOS });
});

// Crear el administrador. Solo funciona si no hay ninguna persona: después de
// eso, los usuarios los crea el administrador desde dentro.
app.post('/api/auth/crear-admin', (req, res) => {
  const n = db.prepare('SELECT COUNT(*) n FROM personas').get().n;
  if (n > 0) return res.status(400).json({ error: 'Ya hay usuarios creados' });
  const b = req.body || {};
  const usuario = String(b.usuario || '').trim().toLowerCase();
  if (!usuario || !b.nombre || !b.pin) return res.status(400).json({ error: 'Faltan datos' });
  if (!pinValido(b.pin)) return res.status(400).json({ error: PIN_MAL });
  const ahora = ahoraISO(), id = nuevoId();
  const clave = nuevaClaveRecuperacion();
  db.prepare(`INSERT INTO personas (id,nombre,usuario,pin_hash,recuperacion_hash,cargo_id,creado_en,actualizado)
              VALUES (?,?,?,?,?, 'admin', ?,?)`)
    .run(id, String(b.nombre).trim(), usuario, hashPin(b.pin), hashPin(clave), ahora, ahora);
  res.json({ ok: true, clave });
});

app.post('/api/auth/entrar', (req, res) => {
  const b = req.body || {};
  const usuario = String(b.usuario || '').trim().toLowerCase();
  const espera = frenado(usuario);
  if (espera) return res.status(429).json({
    error: 'Demasiados intentos fallidos. Espera ' + Math.ceil(espera / 60) + ' minuto(s).' });
  const p = db.prepare('SELECT * FROM personas WHERE usuario=? AND activo=1').get(usuario);
  if (!p || !pinCorrecto(b.pin, p.pin_hash)) {
    fallo(usuario);
    return res.status(401).json({ error: 'Usuario o PIN incorrectos' });
  }
  intentos.delete(usuario);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sesiones (token,persona_id,aparato,creado_en,ultimo_uso) VALUES (?,?,?,?,?)')
    .run(token, p.id, b.aparato || null, ahoraISO(), ahoraISO());
  const cargo = db.prepare('SELECT * FROM cargos WHERE id=?').get(p.cargo_id);
  // Los mismos datos que /api/auth/yo, para que la pantalla no tenga que pedirlos
  // otra vez nada más entrar. «mis_sitios» se calcula con esta persona, que
  // todavía no está en req: acaba de entrar.
  const permisos = permisosDe(p);
  res.json({ ok: true, token, persona: { id: p.id, nombre: p.nombre, sitio_id: p.sitio_id },
             cargo: cargo ? cargo.nombre : '', permisos,
             mis_sitios: idsQueVe({ persona: p, permisos }) });
});

app.post('/api/auth/salir', (req, res) => {
  if (req.token) db.prepare('DELETE FROM sesiones WHERE token=?').run(req.token);
  res.json({ ok: true });
});

app.get('/api/auth/yo', (req, res) => {
  // Cuando se está en la piel de otro, la pantalla tiene que enseñar SUS permisos
  // y su sitio —para eso se hace— pero decir claramente quién es quién.
  const quien = req.comoPersona || req.persona;
  const cargo = db.prepare('SELECT * FROM cargos WHERE id=?').get(quien.cargo_id);
  res.json({
    persona: { id: quien.id, nombre: quien.nombre, sitio_id: quien.sitio_id },
    cargo: cargo ? cargo.nombre : '', cargo_id: quien.cargo_id, permisos: req.permisos,
    // En qué locales se mueve: null = en todos. La pantalla lo usa para no
    // OFRECER siquiera los demás en los desplegables. Ofrecer un sitio en el que
    // el servidor va a contestar 403 es prometer algo que no se va a cumplir
    // (DECISIONES.md #39).
    mis_sitios: idsQueVe(req),
    // Quién firma de verdad, y por quién se está haciendo pasar. La pantalla pinta
    // con esto la tira de arriba, que no puede faltar: sin ella se olvida que se
    // está dentro de otra piel y se apuntan cosas creyendo ser uno mismo.
    como: req.comoPersona ? { id: req.comoPersona.id, nombre: req.comoPersona.nombre,
                              cargo_id: req.comoPersona.cargo_id,
                              cargo: cargo ? cargo.nombre : '',
                              sitio_id: req.comoPersona.sitio_id } : null,
    yo_de_verdad: req.comoPersona
      ? { id: req.persona.id, nombre: req.persona.nombre } : null
  });
});

// ─── VER LA APLICACIÓN COMO OTRO (DECISIONES.md #35) ───────────
// Solo el administrador, y solo hacia alguien que no sea administrador: meterse en
// la piel de otro administrador no enseña nada y es una puerta rara de tener
// abierta.
app.post('/api/auth/como', (req, res) => {
  if (!soyAdmin(req) && !req.comoPersona) return res.status(403).json({ error: SOLO_ADMIN });
  // Estando ya dentro de una piel, los permisos son los del otro, así que
  // 'soyAdmin' diría no. Lo que manda para poder salir o cambiar es quién FIRMA.
  const firmante = db.prepare('SELECT * FROM personas WHERE id=?').get(req.persona.id);
  if (!(permisosDe(firmante) || []).includes('*'))
    return res.status(403).json({ error: SOLO_ADMIN });

  const id = String((req.body || {}).persona_id || '');
  if (!id) {   // sin persona = salir y volver a ser uno mismo
    db.prepare('UPDATE sesiones SET como_persona_id=NULL WHERE token=?').run(req.token);
    return res.json({ ok: true, como: null });
  }
  const otro = db.prepare('SELECT * FROM personas WHERE id=? AND activo=1').get(id);
  if (!otro) return res.status(404).json({ error: 'Esa persona no está o no tiene acceso' });
  if (otro.id === firmante.id) return res.status(400).json({
    error: 'Ya eres tú.' });
  if ((permisosDe(otro) || []).includes('*')) return res.status(400).json({
    error: 'No hace falta hacerse pasar por otro administrador: ve lo mismo que tú.' });
  db.prepare('UPDATE sesiones SET como_persona_id=? WHERE token=?').run(otro.id, req.token);
  console.log('[como] ' + firmante.usuario + ' está viendo la aplicación como ' + otro.usuario);
  const cargo = db.prepare('SELECT nombre FROM cargos WHERE id=?').get(otro.cargo_id);
  res.json({ ok: true, como: { id: otro.id, nombre: otro.nombre, cargo_id: otro.cargo_id,
                               cargo: cargo ? cargo.nombre : '', sitio_id: otro.sitio_id } });
});

// Dar un permiso a un cargo sin salir de donde se está. Es la pieza que hace útil
// lo de arriba: al chocar con una puerta cerrada, el administrador ve el nombre del
// permiso que falta y lo añade al cargo en el momento, sin tener que acordarse de
// cuál era cuando llegue a Ajustes.
//
// Estando en la piel de otro, los permisos son los del otro; por eso aquí se mira
// quién FIRMA y no los permisos de la petición.
app.post('/api/cargos/:id/permiso', (req, res) => {
  const firmante = db.prepare('SELECT * FROM personas WHERE id=?').get(req.persona.id);
  if (!(permisosDe(firmante) || []).includes('*'))
    return res.status(403).json({ error: SOLO_ADMIN });
  const permiso = String((req.body || {}).permiso || '');
  const quitar = !!(req.body || {}).quitar;
  if (!PERMISOS.some(p => p.id === permiso))
    return res.status(400).json({ error: 'Ese permiso no existe' });
  const c = db.prepare('SELECT * FROM cargos WHERE id=? AND borrado_en IS NULL').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Ese cargo no está' });
  if (c.es_admin || c.permisos === '*') return res.status(400).json({
    error: 'El cargo de Administrador ya lo puede todo' });
  const tiene = new Set(String(c.permisos || '').split(',').map(s => s.trim()).filter(Boolean));
  if (quitar) tiene.delete(permiso); else tiene.add(permiso);
  const lista = conImplicados([...tiene]).join(',');
  db.prepare('UPDATE cargos SET permisos=?, actualizado=? WHERE id=?')
    .run(lista, ahoraISO(), c.id);
  // Cuántas personas acaba de tocar esto: dárselo a un cargo no es dárselo a una
  // persona, y conviene decirlo antes de que alguien se sorprenda.
  const cuantas = db.prepare('SELECT COUNT(*) n FROM personas WHERE cargo_id=? AND activo=1')
    .get(c.id).n;
  res.json({ ok: true, cargo: c.nombre, permisos: lista.split(',').filter(Boolean),
             personas: cuantas });
});

// ─── Cargos y trabajadores ────────────────────────────────────
app.get('/api/cargos', exige('gestionar_personas'), (req, res) => {
  res.json({
    cargos: db.prepare(`SELECT * FROM cargos WHERE borrado_en IS NULL
        ORDER BY es_admin DESC, nombre`).all(),
    personas: db.prepare(`SELECT p.id,p.nombre,p.usuario,p.cargo_id,p.sitio_id,p.activo,
        p.moneda_pago, c.nombre cargo, s.nombre sitio FROM personas p
        LEFT JOIN cargos c ON c.id=p.cargo_id LEFT JOIN sitios s ON s.id=p.sitio_id
        ORDER BY p.activo DESC, p.nombre`).all(),
    permisos_posibles: PERMISOS
  });
});

app.post('/api/cargos', exige('gestionar_personas'), (req, res) => {
  const b = req.body || {};
  if (!b.nombre || !String(b.nombre).trim()) return res.status(400).json({ error: 'Falta el nombre' });
  const id = b.id || nuevoId(), ahora = ahoraISO();
  const existente = b.id ? db.prepare('SELECT es_admin FROM cargos WHERE id=?').get(b.id) : null;
  // El cargo de administrador no se puede recortar: si se le quitan permisos
  // por error, nadie podría volver a entrar a arreglarlo.
  if (existente && existente.es_admin) return res.status(400).json({
    error: 'El cargo de Administrador no se puede modificar' });
  // Se aceptan también los nombres VIEJOS y se traducen. Hace falta: un
  // dispositivo con el app.js viejo guardado en su caché manda los de antes, y
  // filtrarlos a secas dejaría el cargo SIN NINGÚN permiso sin decir nada —o sea,
  // dejaría a esa gente fuera de la aplicación por haber tocado «Guardar».
  const pedidos = Array.isArray(b.permisos) ? b.permisos.map(String) : [];
  const dentro = new Set();
  for (const p of pedidos) {
    if (PERMISOS.some(x => x.id === p)) dentro.add(p);
    else if (PERMISOS_VIEJOS[p]) PERMISOS_VIEJOS[p].forEach(n => dentro.add(n));
  }
  // Lo que hace falta para que lo marcado sirva de algo se enciende solo: quien
  // puede vender tiene que poder ver el catálogo.
  const permisos = conImplicados([...dentro]).join(',');
  // Dónde valen esos permisos. Los sitios solo se guardan si el alcance es
  // «estos»: dejar una lista puesta con el alcance en otra cosa es dejar un dato
  // que no manda, y el día que se cambie el alcance haría cosas que nadie pidió.
  const alcance = ['propio', 'lista', 'todos'].includes(b.alcance) ? b.alcance : 'propio';
  const sitios = alcance === 'lista' && Array.isArray(b.sitios)
    ? b.sitios.map(String).filter(s =>
        db.prepare('SELECT 1 FROM sitios WHERE id=?').get(s)).join(',')
    : null;
  db.prepare(`INSERT INTO cargos (id,nombre,permisos,alcance,sitios,es_admin,creado_en,actualizado)
      VALUES (?,?,?,?,?,0,?,?)
      ON CONFLICT(id) DO UPDATE SET nombre=excluded.nombre, permisos=excluded.permisos,
        alcance=excluded.alcance, sitios=excluded.sitios,
        actualizado=excluded.actualizado`)
    .run(id, String(b.nombre).trim(), permisos, alcance, sitios, ahora, ahora);
  // Se devuelve lo que ha QUEDADO guardado, no lo que se pidió: puede llevar
  // permisos que se encendieron solos porque otro los necesita. La pantalla lo
  // compara y lo dice; sin esto, quien desmarcó uno se queda creyendo que se quitó.
  res.json({ ok: true, id, alcance, sitios, permisos: permisos.split(',').filter(Boolean) });
});

// Dar de baja un cargo. Pedido por el dueño el 16 de agosto de 2026: se crearon
// cargos probando la aplicación y no había forma de quitarlos de en medio.
//
// Tres frenos, y ninguno sobra (DECISIONES.md #31):
//   1. El de administrador no, nunca: sin él nadie puede volver a entrar.
//   2. Un cargo que alguien tiene puesto no se va. Si se fuera, esa persona se
//      quedaría sin permisos de golpe —los permisos se leen del cargo en cada
//      petición— y no se sabría por qué. Se dice quiénes lo tienen, para poder
//      cambiárselos antes.
//   3. La fila NO se borra: se le pone la fecha de la baja. Una fila que
//      desaparece no viaja en la sincronización, así que el cargo volvería a
//      salir en cuanto se juntaran dos copias.
app.delete('/api/cargos/:id', exige('gestionar_personas'), (req, res) => {
  const id = String(req.params.id);
  const c = db.prepare('SELECT * FROM cargos WHERE id=?').get(id);
  if (!c || c.borrado_en) return res.status(404).json({ error: 'Ese cargo ya no está' });
  if (c.es_admin) return res.status(400).json({
    error: 'El cargo de Administrador no se puede quitar: sin él nadie podría volver a entrar.' });
  const suyos = db.prepare('SELECT nombre FROM personas WHERE cargo_id=? ORDER BY nombre').all(id);
  if (suyos.length) return res.status(400).json({
    error: 'Este cargo lo tiene ' + (suyos.length === 1 ? '' : suyos.length + ' personas: ') +
           suyos.map(p => p.nombre).join(', ') +
           '. Cámbiale el cargo antes de quitarlo, o se quedaría sin permisos.' });
  const ahora = ahoraISO();
  db.prepare('UPDATE cargos SET borrado_en=?, actualizado=? WHERE id=?').run(ahora, ahora, id);
  res.json({ ok: true });
});

// Vacío o cualquier otra cosa = en la moneda del negocio. No se guarda cuál es
// en ese momento: si el dueño cambiara la moneda del negocio, quien no había
// elegido nada tiene que seguir cobrando en la que se mida entonces.
const monedaPago = m => (m === 'USD' || m === 'CUP') ? m : null;

app.post('/api/personas', exige('gestionar_personas'), (req, res) => {
  const b = req.body || {};
  const nombre = String(b.nombre || '').trim();
  const usuario = String(b.usuario || '').trim().toLowerCase();
  if (!nombre || !usuario) return res.status(400).json({ error: 'Faltan el nombre o el usuario' });
  // Al crear hace falta PIN; al editar solo se comprueba si viene uno nuevo.
  if ((!b.id || b.pin) && !pinValido(b.pin))
    return res.status(400).json({ error: PIN_MAL });
  const otro = db.prepare('SELECT id FROM personas WHERE usuario=? AND id!=?').get(usuario, b.id || '');
  if (otro) return res.status(400).json({ error: 'Ese usuario ya está cogido' });
  const ahora = ahoraISO();
  if (b.id) {
    db.prepare(`UPDATE personas SET nombre=?, usuario=?, cargo_id=?, sitio_id=?, activo=?,
        moneda_pago=?, actualizado=? WHERE id=?`)
      .run(nombre, usuario, b.cargo_id || null, b.sitio_id || null,
           b.activo === false ? 0 : 1, monedaPago(b.moneda_pago), ahora, b.id);
    if (b.pin) {
      db.prepare('UPDATE personas SET pin_hash=? WHERE id=?').run(hashPin(b.pin), b.id);
      // Y fuera sus sesiones abiertas. El PIN se cambia justo cuando se ha
      // sabido: alguien lo vio, o el teléfono se perdió. Sin esto, ese teléfono
      // seguía dentro para siempre, porque la sesión ya no mira el PIN.
      const fuera = db.prepare('DELETE FROM sesiones WHERE persona_id=?').run(b.id).changes;
      if (fuera) console.log('[personas] PIN cambiado: ' + fuera + ' sesión(es) cerradas');
    }
    return res.json({ ok: true, id: b.id });
  }
  const id = nuevoId();
  db.prepare(`INSERT INTO personas
      (id,nombre,usuario,pin_hash,cargo_id,sitio_id,moneda_pago,creado_en,actualizado)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, nombre, usuario, hashPin(b.pin), b.cargo_id || null, b.sitio_id || null,
         monedaPago(b.moneda_pago), ahora, ahora);
  res.json({ ok: true, id });
});

// ─── Comisiones por vendedor ──────────────────────────────────
// Sale de las ventas, que guardan quién las hizo y cuánta comisión generaron.
// Lo que ha vendido cada uno y lo que le toca cobrar.
//
// El «vendido» se sumaba con un SUM(v.total) de SQL, y ahí caían juntas las
// ventas en pesos y las ventas en dólares: 500 pesos y 20 dólares daban 520 de
// nada. Ahora cada venta se pasa a la moneda del negocio con el cambio que
// llevaba congelado, como en todas las demás cuentas (DECISIONES.md #21).
//
// La COMISIÓN ya está guardada en la moneda del negocio, así que esa sí se
// suma tal cual. Y aparte va lo que hay que darle **en la moneda en que se le
// paga a esa persona**, que la elige el administrador: aquí hay quien cobra en
// dólares y quien cobra en pesos, y la cuenta a mano al final del mes es donde
// se equivoca uno.
// EL REPARTO (DECISIONES.md #32, pedido por el dueño el 17 de agosto de 2026).
// La comisión de un día en un sitio se divide a PARTES IGUALES entre quienes
// trabajaron ese día allí, y no se le atribuye a quien marcó la venta.
//
// Los días que no tienen a nadie apuntado siguen como antes: la comisión es de
// quien vendió. Eso no es una concesión, es lo que hace que el cambio se pueda
// desplegar sin tocar un solo día pasado: los meses ya cerrados no tienen lista
// de gente y siguen contando exactamente lo mismo que contaban ayer.
//
// Lo VENDIDO se sigue atribuyendo a quien vendió, aunque la comisión se reparta:
// son dos preguntas distintas («¿quién despachó?» y «¿a quién le toca el
// dinero?») y juntarlas en una cifra no contestaría ninguna.
app.get('/api/comisiones', exige('ver_comisiones'), (req, res) => {
  // El período. Se admite un mes ('2026-08') o un desde/hasta. Hace falta saber
  // de qué MES es, y no solo entre qué fechas, porque lo que ya se le pagó a
  // alguien se apunta contra el mes que se le está pagando: si no, pagar el 2 de
  // septiembre la comisión de agosto no aparecería en agosto (donde se generó) y
  // saldría en septiembre como un pago sin motivo.
  const mesPedido = String(req.query.mes || '').trim();
  let desde, hasta, mes;
  if (/^\d{4}-\d{2}$/.test(mesPedido)) {
    desde = mesPedido + '-01'; hasta = mesPedido + '-31'; mes = mesPedido;
  } else {
    desde = req.query.desde || '0000-01-01';
    hasta = req.query.hasta || '9999-12-31';
    // Solo si el rango cae dentro de un mes natural se puede hablar de lo pagado.
    mes = desde.slice(0, 7) === hasta.slice(0, 7) ? desde.slice(0, 7) : null;
  }
  const base = monedaBase(), hoy = tasaUSD();

  const ventas = db.prepare(`SELECT sitio_id, fecha, persona_id, total, moneda, tasa, comision
      FROM ventas WHERE anulada_en IS NULL AND fecha BETWEEN ? AND ?`).all(desde, hasta);

  // Quiénes trabajaron cada día del período, en una sola consulta.
  const presentes = new Map();          // 'sitio|fecha' → [persona_id]
  for (const p of db.prepare(`SELECT sitio_id, fecha, persona_id FROM dia_personas
      WHERE presente=1 AND fecha BETWEEN ? AND ?`).all(desde, hasta)) {
    const k = p.sitio_id + '|' + p.fecha;
    if (!presentes.has(k)) presentes.set(k, []);
    presentes.get(k).push(p.persona_id);
  }

  const nombres = new Map();
  for (const p of db.prepare('SELECT id, nombre, moneda_pago FROM personas').all())
    nombres.set(p.id, p);

  const porPersona = new Map();
  let sinTasa = false;
  const dame = clave => {
    let a = porPersona.get(clave);
    if (!a) {
      const p = nombres.get(clave);
      a = { persona_id: clave || null,
            persona: p ? p.nombre : 'Sin identificar',
            moneda_pago: p && (p.moneda_pago === 'USD' || p.moneda_pago === 'CUP')
              ? p.moneda_pago : base,
            ventas: 0, vendido: 0, comision: 0, de_reparto: 0, propia: 0, dias: 0 };
      porPersona.set(clave, a);
    }
    return a;
  };

  // Primero lo que vendió cada uno, que no cambia, y las ventas agrupadas por
  // día: la comisión se decide por día entero, no venta a venta.
  const delDia = new Map();             // 'sitio|fecha' → { comision, ventas: [] }
  for (const v of ventas) {
    const a = dame(v.persona_id || '');
    const x = aBase(v.total, v.moneda, v.tasa || hoy);
    if (x === null) sinTasa = true; else a.vendido += x;
    a.ventas++;
    const k = v.sitio_id + '|' + v.fecha;
    if (!delDia.has(k)) delDia.set(k, { comision: 0, ventas: [] });
    const d = delDia.get(k);
    d.comision += Number(v.comision || 0);
    d.ventas.push(v);
  }

  // Y ahora la comisión, día por día: repartida si ese día tiene lista, y de
  // quien vendió si no la tiene.
  for (const [k, d] of delDia) {
    const lista = presentes.get(k);
    if (lista && lista.length) {
      const parte = d.comision / lista.length;
      for (const id of lista) dame(id).de_reparto += parte;
    } else {
      for (const v of d.ventas) dame(v.persona_id || '').propia += Number(v.comision || 0);
    }
  }
  // Los días trabajados se cuentan aunque ese día no hubiera comisión: es la
  // respuesta a «¿cuántos días vino?», que no es lo mismo que «¿cuánto ganó?».
  for (const lista of presentes.values())
    for (const id of lista) dame(id).dias++;

  // Lo que ya se le entregó, por moneda. Se busca por el MES contra el que se
  // apuntó el pago, no por la fecha en que salió el dinero de la caja.
  const pagado = new Map();
  if (mes) {
    for (const f of db.prepare(`SELECT beneficiario_id, moneda, COALESCE(SUM(importe),0) v
        FROM fondo WHERE ref_tipo='comision' AND ref_id=? AND beneficiario_id IS NOT NULL
        GROUP BY beneficiario_id, moneda`).all(mes)) {
      if (!pagado.has(f.beneficiario_id)) pagado.set(f.beneficiario_id, { CUP: 0, USD: 0 });
      pagado.get(f.beneficiario_id)[f.moneda === 'USD' ? 'USD' : 'CUP'] = f.v;
    }
    // Y una fila para quien tenga un pago aunque ese mes no vendiera ni viniera a
    // trabajar. Sin esto el pago se quedaba INVISIBLE: la lista se armaba solo con
    // quien tuviera ventas o días apuntados, así que pagarle a alguien un mes en
    // el que no vendió nada —una comisión atrasada, o un mes en que solo montó
    // trabajos— no salía en ninguna pantalla y ese dinero no se podía ni ver ni
    // deshacer desde aquí.
    for (const id of pagado.keys()) dame(id);
  }

  const comisiones = [...porPersona.values()].map(a => {
    a.comision = a.de_reparto + a.propia;
    const pagar = convertir(a.comision, base, a.moneda_pago);
    a.vendido = redondear(a.vendido, base);
    a.comision = redondear(a.comision, base);
    a.de_reparto = redondear(a.de_reparto, base);
    a.propia = redondear(a.propia, base);
    a.a_pagar = pagar === null ? null : redondear(pagar, a.moneda_pago);
    const pg = pagado.get(a.persona_id) || { CUP: 0, USD: 0 };
    a.pagado = { CUP: redondear(pg.CUP, 'CUP'), USD: redondear(pg.USD, 'USD') };
    // Lo que queda se resta SOLO dentro de la misma moneda. Si a alguien se le
    // pagó parte en la otra, no se inventa una conversión con el dólar de hoy
    // para cuadrarlo: se dice que hay pagos en las dos y se enseñan los dos
    // números (DECISIONES.md #21).
    const otra = a.moneda_pago === 'USD' ? 'CUP' : 'USD';
    a.pagado_en_otra = a.pagado[otra] !== 0;
    a.queda = a.a_pagar === null || a.pagado_en_otra
      ? null : redondear(a.a_pagar - a.pagado[a.moneda_pago], a.moneda_pago);
    return a;
  }).filter(a => a.comision || a.ventas || a.pagado.CUP || a.pagado.USD || a.dias)
    .sort((a, b) => b.comision - a.comision);

  res.json({ comisiones, moneda_base: base, sin_tasa: sinTasa, mes, desde, hasta,
             // Cuántos días del período tienen lista de gente puesta. Si es 0, el
             // reparto no está entrando y conviene decirlo en la pantalla.
             dias_con_lista: presentes.size });
});

// ─── PAGARLE LA COMISIÓN A ALGUIEN ────────────────────────────
// Hasta ahora la comisión era un número que la app calculaba y alguien apuntaba
// en un papel. Pagarla es dinero que SALE de una caja, así que se apunta en el
// fondo como cualquier otra salida: si no, el saldo de la app diría que hay un
// dinero que ya no está.
//
// La fecha del apunte es la de HOY, porque el dinero sale hoy de verdad. Pero se
// guarda además contra qué mes se paga (ref_id), y esa es la pieza que hace que
// pagar en septiembre la comisión de agosto salga en agosto, que es donde se
// generó. Sin eso, agosto se quedaría siempre diciendo que no se ha pagado nada.
app.post('/api/comisiones/pagar', exige('pagar_comisiones'), (req, res) => {
  const b = req.body || {};
  const persona = db.prepare('SELECT * FROM personas WHERE id=?').get(String(b.persona_id || ''));
  if (!persona) return res.status(400).json({ error: 'Esa persona no está en esta copia' });
  const mes = String(b.mes || '');
  if (!/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({
    error: 'Falta el mes que se está pagando' });
  const importe = Number(b.importe);
  if (!(importe > 0)) return res.status(400).json({
    error: 'El importe tiene que ser mayor que cero' });
  const moneda = b.moneda === 'USD' ? 'USD' : 'CUP';
  // De qué caja sale. Si no se dice, sale del negocio y no de un sitio, igual
  // que un retiro: así la gaveta de cada punto sigue cuadrando con el dinero que
  // hay dentro (DECISIONES.md #22).
  const sitio = b.sitio_id ? String(b.sitio_id) : null;
  if (sitio && !db.prepare('SELECT 1 FROM sitios WHERE id=?').get(sitio))
    return res.status(400).json({ error: 'Ese sitio no está en esta copia' });
  // Y el dinero para pagarle tiene que estar (DECISIONES.md #38). Sin sitio se
  // mira el fondo entero, que es de donde estaría saliendo.
  const sinFondo = faltaDinero(sitio, moneda, importe,
    'Apunta primero el dinero que entró en esa caja, o págale desde otra.');
  if (sinFondo) return res.status(400).json({ error: sinFondo });
  const id = apuntarFondo({
    tipo: 'retiro', subtipo: 'comisión', moneda, importe, sitio_id: sitio,
    persona_id: req.persona.id,            // quién lo apuntó
    beneficiario_id: persona.id,           // a quién se le paga
    // Es dinero para la gente, y se marca como tal aunque en los desgloses no se
    // sume por este camino: la comisión ya se resta cuando se GENERA (#33). Se
    // marca para que la pantalla de Dinero pueda enseñarlo agrupado con lo demás
    // que se le paga a la gente, sin tener que adivinarlo por el subtipo.
    es_gente: 1,
    concepto: 'Comisión de ' + mes + ' · ' + persona.nombre +
              (b.concepto ? ' · ' + String(b.concepto).slice(0, 90) : ''),
    ref_tipo: 'comision', ref_id: mes
  });
  console.log('[comisiones] pagado ' + importe + ' ' + moneda + ' a ' + persona.usuario +
              ' por ' + mes);
  res.json({ ok: true, id, saldo: saldoVisible(req), saldo_sitio: sitio ? saldoFondo(sitio) : null });
});

// Deshacer un pago. Es el mismo apunte contrario de siempre (#31), y se hace
// aquí y no en Dinero porque allí se para en seco a todo lo que tiene ref_tipo:
// un pago de comisión tiene dueño, y su dueño es esta pantalla.
app.post('/api/comisiones/pago/:id/anular', exige('pagar_comisiones'), (req, res) => {
  const a = db.prepare('SELECT * FROM fondo WHERE id=?').get(String(req.params.id));
  if (!a) return res.status(404).json({ error: 'Ese pago no está en esta copia' });
  if (a.ref_tipo !== 'comision') return res.status(400).json({
    error: 'Ese apunte no es el pago de una comisión' });
  if (a.anula_a) return res.status(400).json({
    error: 'Eso ya es la anulación de un pago' });
  if (db.prepare('SELECT 1 FROM fondo WHERE anula_a=?').get(a.id))
    return res.status(400).json({ error: 'Ese pago ya estaba anulado' });
  anularApunte(a, req.persona.id);
  res.json({ ok: true, saldo: saldoVisible(req) });
});

// Los pagos que ya se hicieron de un mes, para poder verlos y deshacerlos.
app.get('/api/comisiones/pagos', exige('ver_comisiones'), (req, res) => {
  const mes = String(req.query.mes || '');
  if (!/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ error: 'Falta el mes' });
  const pagos = db.prepare(`SELECT f.id, f.importe, f.moneda, f.fecha, f.concepto,
        f.beneficiario_id, p.nombre persona, s.nombre sitio,
        (SELECT 1 FROM fondo x WHERE x.anula_a = f.id) anulado
      FROM fondo f
      LEFT JOIN personas p ON p.id = f.beneficiario_id
      LEFT JOIN sitios s ON s.id = f.sitio_id
      WHERE f.ref_tipo='comision' AND f.ref_id=? AND f.anula_a IS NULL
      ORDER BY f.ts DESC`).all(mes);
  res.json({ pagos, mes });
});

// La versión del front que sirve ESTE servidor, sacada del propio sw.js. Con
// ella, el aparato puede comparar lo que tiene guardado con lo que hay y saber
// si se quedó con código viejo, en vez de que lo descubra alguien tres días
// después persiguiendo un fallo ya arreglado (DECISIONES.md #7).
//
// Se lee una vez al arrancar: el archivo no cambia mientras el programa vive, y
// un despliegue reinicia el programa.
const VERSION_FRONT = (() => {
  try {
    const sw = fs.readFileSync(path.join(__dirname, 'public', 'sw.js'), 'utf8');
    const m = sw.match(/const CACHE = '([^']+)'/);
    return m ? m[1].replace(/^dp-/, '') : null;
  } catch (e) { return null; }
})();

// Estado del sistema: sirve para comprobar de un vistazo que todo responde.
app.get('/api/salud', (req, res) => {
  const cuenta = t => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  res.json({
    ok: true,
    version: require('./package.json').version,
    front: VERSION_FRONT,
    hora: new Date().toISOString(),
    sitios: cuenta('sitios'),
    // Sin los eliminados: si no, el número no cuadra con lo que se ve en el catálogo
    productos: db.prepare('SELECT COUNT(*) n FROM productos WHERE borrado_en IS NULL').get().n,
    movimientos: cuenta('movimientos'),
    ventas: cuenta('ventas'),
    // Si esta copia va detrás de un proxy con certificado de verdad, no hay
    // sello que instalar y ofrecerlo sería mandar a la gente a una página que
    // no existe.
    hay_sello: fs.existsSync(certificados.ARCHIVOS.caCrt)
  });
});

app.get('/api/sitios', (req, res) => {
  res.json(db.prepare('SELECT * FROM sitios WHERE activo=1 ORDER BY tipo DESC, nombre').all());
});

// ─── Catálogo ─────────────────────────────────────────────────
// Se manda entero: el aparato lo filtra en local, así el buscador es instantáneo
// y seguirá funcionando cuando la app trabaje sin internet.
app.get('/api/productos', exige('ver_catalogo'), (req, res) => {
  // Quien no puede ver ganancias tampoco ve los costos: si viajan al aparato,
  // ya son publicos. Esconder la columna en la pantalla no serviria de nada.
  const productos = productosConPrecios();
  if (!puede(req, 'ver_ganancias')) productos.forEach(p => {
    p.costo = null; p.costo_repo = null; p.comision = null;
  });
  res.json({
    productos,
    sitios: db.prepare('SELECT * FROM sitios WHERE activo=1 ORDER BY tipo DESC, nombre').all()
  });
});

app.post('/api/productos', exige('gestionar_productos'), (req, res) => {
  const b = req.body || {};
  if (!b.nombre || !String(b.nombre).trim()) return res.status(400).json({ error: 'Falta el nombre' });
  const id = nuevoId();
  const codigo = siguienteCodigo();
  const ahora = ahoraISO();
  const foto = revisarFoto(b.foto);
  if (foto === false) return res.status(400).json({
    error: 'La foto es demasiado grande. Hazla otra vez desde la aplicación.' });
  db.prepare(`INSERT INTO productos
      (id, codigo, codigo_barra, nombre, categoria, um, costo, costo_repo, precio,
       precio_moneda, comision, comision_pct, stock_min, foto, destacado, creado_en, actualizado)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, codigo, b.codigo_barra || null, String(b.nombre).trim(), b.categoria || '',
         b.um || 'Unidad', Number(b.costo) || 0, Number(b.costo_repo) || 0,
         Number(b.precio) || 0, b.precio_moneda === 'USD' ? 'USD' : 'CUP',
         Number(b.comision) || 0, b.comision_pct ? 1 : 0,
         Number(b.stock_min) || 0, foto, b.destacado ? 1 : 0, ahora, ahora);
  guardarPreciosSitio(id, b.precios);
  res.json({ ok: true, id, codigo });
});

app.put('/api/productos/:id', exige('gestionar_productos'), (req, res) => {
  const b = req.body || {};
  const existe = db.prepare('SELECT id FROM productos WHERE id=? AND borrado_en IS NULL').get(req.params.id);
  if (!existe) return res.status(404).json({ error: 'Ese producto no existe' });
  // NO MANDAR foto y mandarla VACÍA son dos cosas distintas, y confundirlas borra
  // las fotos de todo el catálogo. Desde que el catálogo viaja sin las fotos, la
  // pantalla no tiene la foto en la mano al editar un producto: si no se toca, no
  // manda nada, y aquí eso tiene que significar «déjala como está». Solo se borra
  // cuando se manda explícitamente vacía, que es lo que hace el botón «Quitar».
  let foto;
  if (b.foto === undefined) {
    foto = db.prepare('SELECT foto FROM productos WHERE id=?').get(req.params.id).foto;
  } else {
    foto = revisarFoto(b.foto);
    if (foto === false) return res.status(400).json({
      error: 'La foto es demasiado grande. Hazla otra vez desde la aplicación.' });
  }
  db.prepare(`UPDATE productos SET codigo_barra=?, nombre=?, categoria=?, um=?, costo=?,
      costo_repo=?, precio=?, precio_moneda=?, comision=?, comision_pct=?, stock_min=?,
      foto=?, destacado=?, actualizado=? WHERE id=?`)
    .run(b.codigo_barra || null, String(b.nombre || '').trim(), b.categoria || '',
         b.um || 'Unidad', Number(b.costo) || 0, Number(b.costo_repo) || 0,
         Number(b.precio) || 0, b.precio_moneda === 'USD' ? 'USD' : 'CUP',
         Number(b.comision) || 0, b.comision_pct ? 1 : 0,
         Number(b.stock_min) || 0, foto, b.destacado ? 1 : 0, ahoraISO(), req.params.id);
  guardarPreciosSitio(req.params.id, b.precios);
  res.json({ ok: true });
});

// Borrado suave: el producto sale del catálogo pero sus movimientos se
// conservan. Borrarlo de verdad dejaría el historial mintiendo.
app.delete('/api/productos/:id', exige('borrar_productos'), (req, res) => {
  const r = db.prepare('UPDATE productos SET borrado_en=?, actualizado=? WHERE id=? AND borrado_en IS NULL')
    .run(ahoraISO(), ahoraISO(), req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Ese producto no existe' });
  res.json({ ok: true });
});

// ─── Sitios ───────────────────────────────────────────────────
// Almacén y punto de venta son la misma tabla con distinto papel. 'padre_id'
// dice de qué almacén se surte; si va vacío, el sitio es independiente.
app.post('/api/sitios', exige('gestionar_sitios'), (req, res) => {
  const b = req.body || {};
  const nombre = String(b.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'Falta el nombre' });
  if (!['almacen', 'punto'].includes(b.tipo)) return res.status(400).json({ error: 'Tipo no válido' });
  const id = nuevoId(), ahora = ahoraISO();
  db.prepare(`INSERT INTO sitios (id,nombre,tipo,padre_id,creado_en,actualizado) VALUES (?,?,?,?,?,?)`)
    .run(id, nombre, b.tipo, b.padre_id || null, ahora, ahora);
  res.json({ ok: true, id });
});

// ─── Stock ────────────────────────────────────────────────────
// Se calcula sumando movimientos (DECISIONES.md #1). No hay ninguna columna
// que guarde "este sitio tiene 47": ese número es el que se pisaban dos
// aparatos en La Inventería y hacía desaparecer mercancía.
app.get('/api/stock', exige('ver_catalogo'), (req, res) => {
  const sitio = req.query.sitio_id;
  if (!sitio) return res.status(400).json({ error: 'Falta el sitio' });
  const filas = db.prepare(
    'SELECT producto_id, SUM(cantidad) cantidad FROM movimientos WHERE sitio_id=? GROUP BY producto_id'
  ).all(sitio);
  const mapa = {};
  filas.forEach(f => { mapa[f.producto_id] = f.cantidad; });
  res.json({ stock: mapa });
});

// Lo que hay en TODO el negocio, y repartido. El almacén principal guarda su
// propia mercancía —lo que está físicamente en su estante— y esto es otra cosa:
// la suma de todos los sitios, para poder contestar «¿cuánto tengo de esto,
// esté donde esté?». Son dos preguntas distintas y las dos hacen falta: mezclar
// las dos en un solo número dejaría al almacén sin saber qué tiene de verdad y
// haría imposible cuadrar su día.
app.get('/api/stock/total', exige('ver_catalogo'), (req, res) => {
  const filas = db.prepare(`SELECT m.producto_id, m.sitio_id, s.nombre sitio,
        SUM(m.cantidad) cantidad
      FROM movimientos m LEFT JOIN sitios s ON s.id = m.sitio_id
      GROUP BY m.producto_id, m.sitio_id HAVING SUM(m.cantidad) <> 0`).all();
  const total = {}, porSitio = {};
  for (const f of filas) {
    total[f.producto_id] = (total[f.producto_id] || 0) + f.cantidad;
    (porSitio[f.producto_id] = porSitio[f.producto_id] || [])
      .push({ sitio_id: f.sitio_id, sitio: f.sitio || '(sitio borrado)', cantidad: f.cantidad });
  }
  for (const p in porSitio) porSitio[p].sort((a, b) => b.cantidad - a.cantidad);
  res.json({ stock: total, por_sitio: porSitio });
});

// ─── LAS DOS MONEDAS ──────────────────────────────────────────
// Cada producto tiene UN precio, en la moneda que le convenga al negocio. El
// precio en la otra moneda lo calcula la app con el valor del dólar que fije el
// administrador. Así solo hay un número que mantener por producto, y cuando el
// dólar se mueve se cambia en un sitio y vale para todo el catálogo.
function tasaUSD() { return Number(ajuste('tasa_usd') || 0); }

function convertir(importe, de, a) {
  return convertirCon(importe, de, a, tasaUSD());
}

// Lo mismo pero con un cambio dado, no con el de hoy. Hace falta para las
// cuentas de atrás: una venta de marzo se convierte con el dólar que había en
// marzo, no con el de hoy. Si no, las ganancias de un mes cerrado cambiarían
// cada vez que se toca el valor del dólar, y un cierre dejaría de significar
// nada (DECISIONES.md #21).
function convertirCon(importe, de, a, tasa) {
  if (de === a) return importe;
  const t = Number(tasa || 0);
  if (!t) return null;                       // sin tasa no se inventa nada
  return de === 'USD' ? importe * t : importe / t;
}

// ─── LA MONEDA DEL NEGOCIO ────────────────────────────────────
// En qué moneda se mide el negocio: los costos, el valor del almacén, las
// ganancias y las comisiones. NO es en qué se cobra —eso se elige en cada
// venta—, es en qué se piensa.
//
// Aquí se compra en dólares y se vende sobre todo en pesos, y el peso se
// devalúa por debajo. Midiendo en pesos, un almacén que no ha cambiado parece
// valer más cada mes y las ganancias salen infladas por la inflación, no por
// vender mejor. Por eso esto es una decisión del negocio y no una constante.
const monedaBase = () => ajuste('moneda_base') === 'USD' ? 'USD' : 'CUP';
// Pasa a la moneda del negocio un importe cobrado, con el cambio que tenía ese
// día. Devuelve null si hace falta el cambio y no lo hay.
const aBase = (importe, moneda, tasa) =>
  convertirCon(importe, moneda === 'USD' ? 'USD' : 'CUP', monedaBase(), tasa);

// ─── LO QUE CUESTA LA GENTE ───────────────────────────────────
// Preguntado por el dueño el 17 de agosto de 2026: «cuando se habla de ganancias,
// ¿se está teniendo en cuenta restar las comisiones y salarios de trabajadores?
// eso debería salir en los desgloces». No se estaba: la ganancia era —y sigue
// siendo— lo vendido menos lo que costó la mercancía. Ahora debajo de ella se
// enseña lo que cuesta la gente y lo que queda (DECISIONES.md #33).
//
// Se cuenta lo GENERADO en el período, no lo entregado, y eso son dos sumas
// distintas que no se pueden mezclar:
//
//   · Las COMISIONES salen de las ventas de esas fechas, se hayan pagado o no.
//     Ya vienen calculadas en enMonedaDelNegocio().
//   · Los SALARIOS y adelantos no se generan solos en ningún sitio: existen
//     cuando alguien los apunta. Para esos, lo apuntado en esas fechas.
//
// Y aquí está la trampa que hay que evitar: los PAGOS de comisión también son
// apuntes de dinero marcados como pago a la gente. Si se sumaran, la comisión se
// restaría dos veces —una al generarse y otra al pagarse—, y un mes en que se
// pagara lo del mes anterior saldría con el doble de coste. Por eso se dejan
// fuera por su ref_tipo: ya están contados en el primer camino.
// «sitio» puede ser uno o una lista de varios: quien solo ve su tienda tampoco
// puede ver lo que cuesta la gente de las demás (#39).
function pagosALaGente(desde, hasta, sitio) {
  const lista = !sitio ? [] : (Array.isArray(sitio) ? sitio : [sitio]);
  const filas = db.prepare(`SELECT moneda, COALESCE(SUM(importe),0) v FROM fondo
      WHERE es_gente=1 AND COALESCE(ref_tipo,'') <> 'comision'
        AND fecha BETWEEN ? AND ?` +
      (lista.length ? ' AND sitio_id IN (' + lista.map(() => '?').join(',') + ')' : '') +
      ' GROUP BY moneda')
    .all(...[desde, hasta].concat(lista));
  // Puede haber salarios pagados en las dos monedas, así que se pasan a la del
  // negocio para poder restarlos de una ganancia que está en esa moneda. Se usa
  // el dólar de hoy, que es lo que hace el resto del fondo: un apunte de dinero
  // no lleva tasa congelada, solo las ventas la llevan.
  let total = 0, sinTasa = false;
  for (const f of filas) {
    const x = aBase(f.v, f.moneda, tasaUSD());
    if (x === null) sinTasa = true; else total += x;
  }
  return { total: redondear(total, monedaBase()), sin_tasa: sinTasa };
}

// Las cuentas de un montón de ventas, puestas en la moneda del negocio. Cada
// venta se convierte con el cambio que llevaba congelado; las de antes de que
// existiera esa columna se quedaron en 0 y para esas se usa el de hoy, que es
// lo único que hay.
function enMonedaDelNegocio(ventas) {
  const hoy = tasaUSD();
  let vendido = 0, costo = 0, comision = 0, sinTasa = false;
  for (const v of ventas) {
    const x = aBase(v.total, v.moneda, v.tasa || hoy);
    if (x === null) sinTasa = true; else vendido += x;
    costo += Number(v.costo_total || 0);
    comision += Number(v.comision || 0);
  }
  const red = n => redondear(n, monedaBase());
  return { vendido: red(vendido), costo: red(costo), comision: red(comision),
           ganancia: red(vendido - costo), sin_tasa: sinTasa, moneda: monedaBase() };
}

// A la moneda dura se redondea a dos decimales; el peso, a peso entero.
const redondear = (n, moneda) =>
  moneda === 'USD' ? Math.round(n * 100) / 100 : Math.round(n);

// El precio que rige en un sitio, expresado en la moneda que se pida.
function precioEn(productoId, sitioId, moneda) {
  const p = db.prepare('SELECT precio, precio_moneda FROM productos WHERE id=?').get(productoId);
  if (!p) return 0;
  const ex = db.prepare('SELECT precio FROM precios_sitio WHERE producto_id=? AND sitio_id=?')
    .get(productoId, sitioId);
  const base = ex && ex.precio > 0 ? ex.precio : p.precio;   // la excepción va en su misma moneda
  const conv = convertir(base, p.precio_moneda || 'CUP', moneda === 'USD' ? 'USD' : 'CUP');
  if (conv === null) throw new Error(
    'Falta poner el valor del dólar en Ajustes para poder cobrar en la otra moneda');
  return redondear(conv, moneda);
}

// ─── Denominaciones para el contador de billetes ──────────────
// Se guardan en el servidor y no en el aparato: si el jefe quita un billete
// que ya no circula, tiene que desaparecer en todos los puntos, no solo en el
// teléfono donde lo cambió.
const DENOMS_POR_DEFECTO = {
  CUP: [1, 3, 5, 10, 20, 50, 100, 200, 500, 1000],
  USD: [1, 5, 10, 20, 50, 100]
};
function denominaciones() {
  try {
    const g = JSON.parse(ajuste('denominaciones') || 'null');
    if (g && Array.isArray(g.CUP) && Array.isArray(g.USD)) return g;
  } catch (e) {}
  return DENOMS_POR_DEFECTO;
}
app.get('/api/denominaciones', (req, res) => res.json(denominaciones()));
app.post('/api/denominaciones', exige('reglas_negocio'), (req, res) => {
  const limpiar = l => [...new Set((Array.isArray(l) ? l : [])
    .map(Number).filter(n => n > 0))].sort((a, b) => b - a);
  const cup = limpiar((req.body || {}).CUP), usd = limpiar((req.body || {}).USD);
  if (!cup.length || !usd.length)
    return res.status(400).json({ error: 'Cada moneda necesita al menos una denominación' });
  ajuste('denominaciones', JSON.stringify({ CUP: cup, USD: usd }));
  res.json({ ok: true, CUP: cup, USD: usd });
});

app.get('/api/tasa', (req, res) => res.json({ tasa: tasaUSD(), moneda_base: monedaBase(),
                                               vender_sin_stock: dejaVenderSinStock() }));

// ─── Cambiar la moneda del negocio ────────────────────────────
// Esto no es un ajuste de pantalla: convierte TODO lo que hay guardado —los
// costos de los productos, los de cada movimiento, el costo y la comisión de
// cada venta— de una moneda a la otra, de una vez y para siempre.
//
// Se hace así, y no dejando cada cifra en su moneda con una etiqueta, porque el
// valor del almacén y la ganancia tienen que poder sumarse. Y se hace UNA vez,
// con un cambio que decide el dueño, en lugar de convertir al vuelo: si se
// convirtiera al leer, las ganancias de un mes cerrado cambiarían cada vez que
// se moviera el dólar (DECISIONES.md #21).
// También SOLO EL ADMINISTRADOR, por lo mismo que la tasa y con más razón: esto
// reescribe todos los costos guardados de una vez y no hay botón de deshacer.
app.post('/api/moneda-base', exige('*'), (req, res) => {
  if (!puede(req, 'gestionar_productos')) return res.status(403).json({
    error: 'Cambiar la moneda del negocio toca los costos del catálogo: hace falta también ' +
           'permiso para gestionar productos.' });
  const b = req.body || {};
  const nueva = b.moneda === 'USD' ? 'USD' : 'CUP';
  const vieja = monedaBase();
  if (nueva === vieja) return res.json({ ok: true, moneda_base: vieja, cambiadas: 0 });
  const tasa = Number(b.tasa);
  if (!(tasa > 0)) return res.status(400).json({
    error: 'Falta a cuánto está el dólar para poder convertir lo que ya hay guardado.' });

  // De CUP a USD se divide; de USD a CUP se multiplica.
  const factor = nueva === 'USD' ? 1 / tasa : tasa;
  const dec = nueva === 'USD' ? 2 : 0;      // en dólares se guardan centavos
  let tocadas = 0;
  try {
    db.transaction(() => {
      const upd = (sql, ...args) => { tocadas += db.prepare(sql).run(...args).changes; };
      upd(`UPDATE productos SET costo = ROUND(costo * ?, ?), costo_repo = ROUND(costo_repo * ?, ?),
           actualizado = ? WHERE costo <> 0 OR costo_repo <> 0`, factor, dec, factor, dec, ahoraISO());
      upd('UPDATE movimientos SET costo_unit = ROUND(costo_unit * ?, ?) WHERE costo_unit <> 0', factor, dec);
      upd(`UPDATE ventas SET costo_total = ROUND(costo_total * ?, ?),
           comision = ROUND(comision * ?, ?) WHERE costo_total <> 0 OR comision <> 0`,
          factor, dec, factor, dec);
      // Las comisiones fijas del catálogo también son dinero. Las que son un
      // porcentaje no se tocan: un 5% es un 5% en cualquier moneda.
      upd(`UPDATE productos SET comision = ROUND(comision * ?, ?) WHERE comision_pct = 0 AND comision <> 0`,
          factor, dec);
      // Las líneas de una inversión llevan su propia moneda declarada, así que
      // esas NO se convierten: siguen valiendo lo que decía el papel.
      ajuste('moneda_base', nueva);
      ajuste('moneda_base_cambiada', ahoraISO() + ' · de ' + vieja + ' a ' + nueva + ' a ' + tasa);
    })();
  } catch (e) { return res.status(500).json({ error: 'No se pudo convertir: ' + e.message }); }
  console.log('[moneda] el negocio pasa a medirse en ' + nueva + ' (cambio ' + tasa + ')');
  res.json({ ok: true, moneda_base: nueva, tasa, filas: tocadas });
});
// SOLO EL ADMINISTRADOR. Antes bastaba con 'gestionar_productos', o sea que
// cualquiera que pudiera editar un producto podía cambiar a cuánto está el
// dólar — y ese número no es un dato de un producto: es la vara con la que se
// mide el negocio entero. Con él se calcula el precio en la otra moneda de todo
// el catálogo, lo que se cobra en la caja, el valor del almacén y las
// comisiones. Un cero de más puesto por quien estaba etiquetando mercancía
// mueve todas esas cifras a la vez, y no hay ninguna pantalla que grite.
//
// 'exige("*")' quiere decir administrador y nadie más: '*' es el único permiso
// que no se le puede poner a un cargo desde la pantalla de cargos (mira
// PERMISOS), así que solo lo tiene quien manda.
//
// Leerla (GET, más arriba) sigue abierto a todos: sin el valor del dólar, quien
// está en la caja no puede cobrar en la otra moneda.
app.post('/api/tasa', exige('*'), (req, res) => {
  const t = Number((req.body || {}).tasa);
  if (!(t >= 0)) return res.status(400).json({ error: 'Valor no válido' });
  ajuste('tasa_usd', String(t));
  res.json({ ok: true, tasa: t });
});

// ─── REPASAR LOS COSTOS ───────────────────────────────────────
// Entre el 12 y el 14 de agosto de 2026 la casilla del costo convertía a pesos
// SIEMPRE, midiera el negocio en lo que midiera. Con la medida en dólares,
// escribir 300 guardaba 207 000 y el servidor lo leía como 207 000 dólares. El
// código está arreglado, pero eso NO repara lo que quedó escrito: el costo malo
// sigue ahí, y arrastra la ganancia de cada venta y de cada trabajo que lo usó.
//
// Esta pantalla no inventa ningún número, que sería peor que el fallo. Propone
// lo que se puede DEMOSTRAR, en este orden:
//
//   1. Lo que costó de verdad, sacado de la línea de la última INVERSIÓN
//      registrada de ese producto. Eso salió de una factura.
//   2. Si el producto nunca entró por una inversión, deshacer la conversión de
//      más: el costo guardado dividido por el valor del dólar. Devuelve
//      exactamente la cifra que se tecleó.
//
// Y siempre se puede escribir el número a mano, que es lo que manda.
const costoDeLaInversion = db.prepare(`SELECT il.costo_unit, i.moneda, i.numero, i.fecha
    FROM inversion_lineas il JOIN inversiones i ON i.id = il.inversion_id
    WHERE il.producto_id = ? AND i.estado = 'registrada' AND il.costo_unit > 0
    ORDER BY i.fecha DESC, i.creado_en DESC LIMIT 1`);

// Un costo por encima del precio de venta. Nadie compra a 300 para vender a 250:
// cuando pasa, casi siempre es la moneda equivocada y no una mala compra.
function costosSospechosos() {
  const base = monedaBase(), tasa = tasaUSD();
  const fuera = [];
  for (const p of db.prepare(`SELECT id, codigo, nombre, costo, costo_repo, precio, precio_moneda
      FROM productos WHERE borrado_en IS NULL AND costo > 0`).all()) {
    const precioBase = convertir(p.precio, p.precio_moneda === 'USD' ? 'USD' : 'CUP', base);
    if (precioBase === null || !(precioBase > 0) || p.costo <= precioBase) continue;

    const opciones = [];
    const inv = costoDeLaInversion.get(p.id);
    if (inv) {
      const c = convertir(inv.costo_unit, inv.moneda, base);
      if (c !== null && c > 0) opciones.push({ costo: redondear(c, base),
        de: 'inversion', texto: 'Lo que costó en ' + inv.numero + ' (' + inv.fecha + ')' });
    }
    if (tasa > 0) {
      const c = base === 'USD' ? p.costo / tasa : p.costo * tasa;
      if (c > 0) opciones.push({ costo: redondear(c, base), de: 'deshacer',
        texto: 'Deshacer la conversión de más (dividir por ' + tasa + ')' });
    }

    // Lo que arrastra ese costo malo. Se cuenta para que el dueño vea que esto
    // no es cambiar un número del catálogo: es la ganancia de todo lo que se
    // vendió con él.
    const igual = 'ABS(costo_unit - ?) < 0.005';
    fuera.push({
      id: p.id, codigo: p.codigo, nombre: p.nombre, costo: p.costo,
      costo_repo: p.costo_repo, precio: p.precio, precio_moneda: p.precio_moneda,
      precio_en_base: redondear(precioBase, base),
      veces: precioBase > 0 ? Math.round(p.costo / precioBase) : null,
      opciones,
      propuesto: opciones.length ? opciones[0].costo : null,
      de_donde: opciones.length ? opciones[0].de : null,
      arrastre: {
        movimientos: db.prepare(`SELECT COUNT(*) n FROM movimientos
            WHERE producto_id=? AND ${igual}`).get(p.id, p.costo).n,
        ventas: db.prepare(`SELECT COUNT(DISTINCT ref_id) n FROM movimientos
            WHERE producto_id=? AND tipo='venta' AND ref_tipo='venta' AND ${igual}`)
          .get(p.id, p.costo).n,
      },
    });
  }
  return { moneda_base: base, tasa, productos: fuera.sort((a, b) => b.costo - a.costo) };
}

// Solo quien puede ver ganancias: aquí se enseñan los costos de todo el
// catálogo, que es justo lo que la decisión #10 no le da a quien solo vende.
app.get('/api/costos/repasar', exige('corregir_costos'), (req, res) => {
  res.json(costosSospechosos());
});

app.post('/api/costos/corregir', exige('corregir_costos'), async (req, res) => {
  if (!puede(req, 'ver_ganancias')) return res.status(403).json({
    error: 'Corregir costos cambia las ganancias que ya están apuntadas: hace falta también ' +
           'permiso para verlas.' });
  const b = req.body || {};
  if (String(b.confirmacion || '').trim().toUpperCase() !== 'CORREGIR')
    return res.status(400).json({ error: 'Hay que escribir CORREGIR para confirmar' });
  const piden = Array.isArray(b.correcciones) ? b.correcciones : [];
  if (!piden.length) return res.status(400).json({ error: 'No has elegido ningún producto' });

  const base = monedaBase();
  // Se validan TODAS antes de tocar nada: media corrección deja el catálogo
  // peor de como estaba, con unos productos arreglados y otros no.
  const trabajo = [];
  for (const c of piden) {
    const p = db.prepare('SELECT * FROM productos WHERE id=? AND borrado_en IS NULL').get(c.producto_id);
    if (!p) return res.status(404).json({ error: 'Un producto de la lista ya no existe' });
    const nuevo = Number(c.costo);
    if (!(nuevo > 0)) return res.status(400).json({
      error: 'El costo nuevo de «' + p.nombre + '» tiene que ser mayor que cero' });
    if (!(p.costo > 0)) return res.status(400).json({
      error: '«' + p.nombre + '» no tiene costo que corregir' });
    trabajo.push({ p, viejo: p.costo, nuevo: redondear(nuevo, base), factor: nuevo / p.costo });
  }

  // La copia va ANTES y fuera de la transacción, como en el borrado: si falla,
  // no se toca un solo número.
  let copia = null;
  try { copia = await salvar('antes de corregir costos'); }
  catch (e) { return res.status(500).json({
    error: 'No se pudo hacer la copia de seguridad, así que no se ha cambiado nada: ' + e.message }); }

  const hecho = { productos: 0, movimientos: 0, ventas: 0 };
  const detalle = [];
  try {
    db.transaction(() => {
      const ahora = ahoraISO();
      for (const t of trabajo) {
        const { p, viejo, nuevo, factor } = t;
        // El costo de reposición lleva el mismo error, así que la misma cuenta.
        const repoNuevo = p.costo_repo ? redondear(p.costo_repo * factor, base) : p.costo_repo;
        db.prepare('UPDATE productos SET costo=?, costo_repo=?, actualizado=? WHERE id=?')
          .run(nuevo, repoNuevo, ahora, p.id);
        hecho.productos++;

        // Solo los apuntes que llevan EXACTAMENTE el costo malo. Si un producto
        // entró tres veces a precios distintos, los otros dos eran correctos y
        // no se tocan: aquí no se reescribe la historia, se corrige un error.
        const movs = db.prepare(`UPDATE movimientos SET costo_unit=?
            WHERE producto_id=? AND ABS(costo_unit - ?) < 0.005`).run(nuevo, p.id, viejo).changes;
        hecho.movimientos += movs;

        // El costo de una venta es la suma del de sus líneas. Se vuelve a sumar
        // en vez de escalarlo, para que quede cuadrado con los apuntes aunque la
        // venta llevara varios productos y solo uno estuviera mal.
        const ventas = db.prepare(`UPDATE ventas SET costo_total = (
              SELECT COALESCE(SUM(-m.cantidad * m.costo_unit),0) FROM movimientos m
              WHERE m.ref_tipo='venta' AND m.ref_id = ventas.id AND m.anula_a IS NULL)
            WHERE id IN (SELECT DISTINCT ref_id FROM movimientos
              WHERE producto_id=? AND tipo='venta' AND ref_tipo='venta')`).run(p.id).changes;
        hecho.ventas += ventas;

        detalle.push({ nombre: p.nombre, codigo: p.codigo, de: viejo, a: nuevo,
                       movimientos: movs, ventas });
      }
    })();
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo corregir: ' + e.message +
      '. No se cambió nada y la copia ' + copia + ' está a salvo.' });
  }

  console.log('[costos] corregidos ' + hecho.productos + ' producto(s) · copia ' + copia +
              ' · ' + JSON.stringify(hecho));
  res.json({ ok: true, copia, hecho, detalle, moneda_base: base });
});

// Si la caja deja cobrar algo sin existencia. Lo cambia quien lleva el
// inventario, no cualquiera: es una regla del negocio, no una preferencia.
app.post('/api/vender-sin-stock', exige('reglas_negocio'), (req, res) => {
  ajuste('vender_sin_stock', (req.body || {}).permitir ? '1' : '0');
  res.json({ ok: true, vender_sin_stock: dejaVenderSinStock() });
});

// ─── Ventas ───────────────────────────────────────────────────
// Lo que hay de un producto en un sitio, sumado de sus movimientos: aquí no
// hay ningún número guardado que consultar (DECISIONES.md #1).
const stockDe = (sitio, producto) => db.prepare(
  'SELECT COALESCE(SUM(cantidad),0) c FROM movimientos WHERE sitio_id=? AND producto_id=?')
  .get(sitio, producto).c;

// ─── EL GUARDIÁN DE LA MERCANCÍA QUE NO ESTÁ ──────────────────
// No se rebaja lo que no existe (DECISIONES.md #40). Va en UNA sola función,
// como el guardián del dinero (#38), y por ella pasan todos los caminos por los
// que sale mercancía: la venta, la merma, el ajuste que resta, el despacho a
// otro punto, el material de un trabajo y la cancelación de una inversión.
//
// Lo que hay de cada pareja sitio-producto, en una sola consulta: preguntarlo
// línea por línea son veinte consultas para pintar una pantalla, y esto se pide
// cada vez que se toca una cantidad.
function stockDePares(pares) {
  if (!pares.length) return {};
  const sitios = [...new Set(pares.map(p => p.split('|')[0]))];
  const prods = [...new Set(pares.map(p => p.split('|')[1]))];
  const filas = db.prepare(`SELECT sitio_id, producto_id, COALESCE(SUM(cantidad),0) c
      FROM movimientos WHERE sitio_id IN (${huecos(sitios.length)})
        AND producto_id IN (${huecos(prods.length)}) GROUP BY sitio_id, producto_id`)
    .all(...sitios, ...prods);
  const m = {};
  filas.forEach(f => { m[f.sitio_id + '|' + f.producto_id] = f.c; });
  return m;
}

// Qué falta, de una lista de {sitio_id, producto_id, cantidad}. Devuelve una
// fila por cada cosa que no alcanza, con lo que hay y dónde.
//
// Se agrupa por sitio y producto ANTES de comparar: el mismo producto puede
// venir en dos líneas —dos medidas de cable, dos renglones del mismo despacho— y
// mirar cada una por separado deja pasar un total que no cabe.
//
// Y se mira el estante de AHORA, sin fechas: la mercancía no sabe de períodos,
// igual que el saldo de una caja (#38).
function queFalta(pedidos) {
  const pide = new Map();
  for (const p of pedidos || []) {
    const cant = Math.abs(Number(p.cantidad) || 0);
    if (!p.sitio_id || !p.producto_id || !cant) continue;
    const k = p.sitio_id + '|' + p.producto_id;
    if (!pide.has(k)) pide.set(k, { sitio_id: p.sitio_id, producto_id: p.producto_id,
                                    nombre: p.nombre || '', um: p.um || '', pide: 0 });
    const e = pide.get(k);
    e.pide += cant;
    if (!e.nombre && p.nombre) e.nombre = p.nombre;
    if (!e.um && p.um) e.um = p.um;
  }
  if (!pide.size) return [];
  const stock = stockDePares([...pide.keys()]);
  const falta = [];
  for (const [k, p] of pide) {
    const hay = Number(stock[k] || 0);
    // Un pelo de margen: las cantidades llevan decimales —metros de cable— y
    // sacar exactamente lo que hay no puede fallar por una millonésima.
    if (p.pide <= hay + 0.0001) continue;
    if (!p.nombre || !p.um) {
      const prod = db.prepare('SELECT nombre, um FROM productos WHERE id=?').get(p.producto_id) || {};
      p.nombre = p.nombre || prod.nombre || 'un producto';
      p.um = p.um || prod.um || '';
    }
    const s = db.prepare('SELECT nombre FROM sitios WHERE id=?').get(p.sitio_id);
    falta.push(Object.assign(p, { hay, sitio: (s && s.nombre) || '(sitio borrado)' }));
  }
  return falta;
}

// Las cantidades no son dinero: se enseñan tal cual, sin céntimos de más.
const enUnidades = n => Math.round(Number(n) * 10000) / 10000;

// El cartel. Dice la cifra —para poder arreglar la cantidad sin ir a buscarla— y
// dice la salida: un freno que solo dice que no deja a quien lo encuentra sin
// saber si la aplicación está rota. Devuelve el texto, o null si no falta nada.
function faltaMercancia(pedidos, consejo) {
  const falta = queFalta(pedidos);
  if (!falta.length) return null;
  const salida = ' ' + (consejo || 'Si esa mercancía llegó y no se apuntó, regístrala primero ' +
    'como entrada en ese sitio; y si ya salió, lo que está mal es la cantidad de aquí.');
  const cuanto = f => (f.hay > 0 ? 'quedan ' + enUnidades(f.hay) + (f.um ? ' ' + f.um : '')
                                 : 'no queda nada');
  if (falta.length === 1) {
    const f = falta[0];
    return 'De «' + f.nombre + '» en ' + f.sitio + ' ' + cuanto(f) + ', y estás sacando ' +
      enUnidades(f.pide) + '. No se puede rebajar mercancía que no está.' + salida;
  }
  return 'No se puede rebajar mercancía que no está:\n' +
    falta.map(f => '· «' + f.nombre + '»: en ' + f.sitio + ' ' + cuanto(f) +
                   ' y estás sacando ' + enUnidades(f.pide)).join('\n') + '\n\n' + salida.trim();
}

// Si la caja deja cobrar algo que el inventario dice que no está.
//
// Viene CERRADO: lo decidió el dueño, y tiene razón en su tienda física — no se
// puede vender lo que no está en el estante. Lo que hay que tener presente es
// el otro lado: el día que llegue mercancía y nadie la apunte, la caja no podrá
// cobrarla. La salida no es forzar la venta, es apuntar la entrada, que además
// es lo que había que hacer de todas formas.
//
// Se deja como ajuste porque con varios aparatos sin internet esto no puede
// garantizarse del todo: dos cajas pueden vender a la vez la última unidad y
// solo se ve al juntarlas. Por eso el stock en negativo se sigue enseñando.
const dejaVenderSinStock = () => ajuste('vender_sin_stock') === '1';
// Una venta = una fila en 'ventas' (la cabecera) + una fila en 'movimientos'
// por cada producto, con cantidad NEGATIVA. El stock baja porque baja la suma,
// no porque se reescriba ningún número.
app.post('/api/ventas', exige('vender'), (req, res) => {
  const b = req.body || {};
  const sitio = b.sitio_id;
  const lineas = Array.isArray(b.lineas) ? b.lineas : [];
  if (!sitio) return res.status(400).json({ error: 'Falta el sitio' });
  if (!lineas.length) return res.status(400).json({ error: 'La venta no tiene productos' });

  const ventaId = nuevoId(), ahora = ahoraISO(), ts = Date.now();
  const fecha = b.fecha || ahora.slice(0, 10);
  const moneda = b.moneda === 'USD' ? 'USD' : 'CUP';
  if (siCerradoCortar(res, sitio, fecha)) return;

  const insVenta = db.prepare(`INSERT INTO ventas
    (id,sitio_id,aparato_id,persona_id,moneda,tasa,total,costo_total,comision,forma_pago,cliente,fecha,ts,creado_en)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insMov = db.prepare(`INSERT INTO movimientos
    (id,tipo,sitio_id,aparato_id,persona_id,producto_id,cantidad,costo_unit,precio_unit,
     ref_tipo,ref_id,fecha,ts,creado_en)
    VALUES (?,'venta',?,?,?,?,?,?,?,'venta',?,?,?,?)`);

  const hacer = db.transaction(() => {
    let total = 0, costoTotal = 0, comisionTotal = 0;
    // Primero se mira la venta ENTERA y después se apunta. Comprobando línea por
    // línea sobre la marcha hay que llevar aparte la cuenta de lo ya apartado —si
    // el mismo producto viene en dos líneas, mirar el estante cada vez deja pasar
    // el doble de lo que hay—, y esa cuenta ya la lleva el guardián común, que
    // agrupa por sitio y producto antes de comparar.
    const pedidos = [];
    for (const l of lineas) {
      const prod = db.prepare('SELECT * FROM productos WHERE id=? AND borrado_en IS NULL').get(l.producto_id);
      if (!prod) throw new Error('Un producto de la venta ya no existe');
      const cant = Number(l.cantidad) || 0;
      if (cant <= 0) throw new Error('Cantidad no válida');
      pedidos.push({ sitio_id: sitio, producto_id: prod.id, cantidad: cant,
                     nombre: prod.nombre, um: prod.um, prod, cant });
    }
    // No se vende lo que no está. Lo comprueba el SERVIDOR y no la pantalla,
    // porque esconder un botón es decoración (DECISIONES.md #10).
    if (!dejaVenderSinStock()) {
      const falta = faltaMercancia(pedidos, 'Si la mercancía llegó y no se apuntó, ' +
        'regístrala primero como entrada en el Almacén.');
      if (falta) throw new Error(falta);
    }
    for (const { prod, cant } of pedidos) {
      // El precio lo pone el servidor, no el aparato: así nadie puede cobrar
      // por debajo cambiando lo que manda.
      const precio = precioEn(prod.id, sitio, moneda);
      // La comisión va en la moneda del negocio, como el costo: es una parte
      // de la ganancia, y la ganancia se mide en una sola moneda.
      const precioBase = precioEn(prod.id, sitio, monedaBase());
      const comision = prod.comision_pct ? precioBase * (prod.comision / 100) : prod.comision;
      total += precio * cant;
      costoTotal += prod.costo * cant;
      comisionTotal += comision * cant;
      insMov.run(nuevoId(), sitio, b.aparato_id || null, req.persona.id,
                 prod.id, -cant, prod.costo, precio, ventaId, fecha, ts, ahora);
    }
    // El cambio del día se congela con la venta. Sin esto, tocar el valor del
    // dólar en Ajustes movería las ganancias de todos los meses anteriores,
    // incluidas las jornadas ya cerradas (DECISIONES.md #21).
    insVenta.run(ventaId, sitio, b.aparato_id || null, req.persona.id, moneda, tasaUSD(),
                 total, costoTotal, comisionTotal, 'efectivo',
                 b.cliente || null, fecha, ts, ahora);
    // El dinero de la venta entra al fondo en el momento. Ojo con leerlo: el
    // fondo cuenta también lo que sigue en la gaveta de cada punto.
    apuntarFondo({
      tipo: 'ingreso', subtipo: 'venta', moneda, importe: total, sitio_id: sitio,
      concepto: 'Venta', ref_tipo: 'venta', ref_id: ventaId, fecha, ts
    });
    // Aquí no hay que decir a qué inversión pertenece la venta: si el producto
    // entró con una, sus unidades se cuentan solas al sacar las cuentas de esa
    // inversión. Preguntarlo en la caja sería una decisión más en el peor
    // momento, y una forma nueva de equivocarse.
    return { total, comisionTotal, moneda };
  });

  try {
    const r = hacer();
    res.json({ ok: true, id: ventaId, total: r.total, moneda: r.moneda, comision: r.comisionTotal });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/ventas', exige('ver_ventas'), (req, res) => {
  const sitio = req.query.sitio_id;
  const fecha = req.query.fecha || new Date().toISOString().slice(0, 10);
  if (!sitio) return res.status(400).json({ error: 'Falta el sitio' });
  const ventas = db.prepare(
    'SELECT * FROM ventas WHERE sitio_id=? AND fecha=? ORDER BY ts DESC').all(sitio, fecha);
  const lineas = db.prepare(`SELECT m.*, p.nombre, p.codigo FROM movimientos m
      JOIN productos p ON p.id=m.producto_id
      WHERE m.ref_tipo='venta' AND m.sitio_id=? AND m.fecha=? AND m.anula_a IS NULL
      ORDER BY m.ts`).all(sitio, fecha);
  const porVenta = {};
  lineas.forEach(l => (porVenta[l.ref_id] = porVenta[l.ref_id] || []).push(l));
  ventas.forEach(v => { v.lineas = porVenta[v.id] || []; });
  res.json({ ventas });
});

// Anular NO borra: mete el movimiento contrario apuntando al original
// (DECISIONES.md #2). Así el historial cuenta lo que pasó de verdad.
app.post('/api/ventas/:id/anular', exige('anular_venta'), (req, res) => {
  const venta = db.prepare('SELECT * FROM ventas WHERE id=?').get(req.params.id);
  if (!venta) return res.status(404).json({ error: 'Esa venta no existe' });
  if (venta.anulada_en) return res.status(400).json({ error: 'Esa venta ya estaba anulada' });
  const movs = db.prepare(
    "SELECT * FROM movimientos WHERE ref_tipo='venta' AND ref_id=? AND anula_a IS NULL"
  ).all(req.params.id);
  const ahora = ahoraISO(), ts = Date.now();
  const ins = db.prepare(`INSERT INTO movimientos
    (id,tipo,sitio_id,producto_id,cantidad,costo_unit,precio_unit,ref_tipo,ref_id,anula_a,motivo,fecha,ts,creado_en)
    VALUES (?,'devolucion',?,?,?,?,?,'venta',?,?,?,?,?,?)`);
  db.transaction(() => {
    for (const m of movs) {
      ins.run(nuevoId(), m.sitio_id, m.producto_id, -m.cantidad, m.costo_unit, m.precio_unit,
              m.ref_id, m.id, 'Venta anulada', m.fecha, ts, ahora);
    }
    db.prepare('UPDATE ventas SET anulada_en=? WHERE id=?').run(ahora, req.params.id);
    // El dinero también se deshace, con un apunte contrario. El ingreso
    // original se queda: el fondo cuenta lo que pasó, no lo que quedó.
    apuntarFondo({ tipo: 'ingreso', subtipo: 'venta', moneda: venta.moneda || 'CUP',
                   importe: -venta.total, sitio_id: venta.sitio_id, concepto: 'Venta anulada',
                   ref_tipo: 'venta', ref_id: venta.id, fecha: venta.fecha, ts });
  })();
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════
//  SINCRONIZACIÓN
// ═══════════════════════════════════════════════════════════════
// Juntar dos copias es SUMAR, no decidir quién gana. Eso solo es posible por
// las reglas 1, 2 y 3 de DECISIONES.md: el stock se calcula, los movimientos no
// se editan, y cada dato tiene un dueño. Aquí se ve el pago de esa disciplina:
// esta función es corta, y da igual el orden y el número de veces que se junte.
//
// Cómo se fusiona cada tabla:
//   · Listas de apuntes (movimientos, fondo, conteos): INSERT OR IGNORE por id.
//     Son inmutables, así que reinsertar no puede cambiar nada.
//   · Catálogo y personas: dueño único (el administrador), gana el más reciente.
//   · Ventas y traslados: se insertan una vez, y solo avanzan en un sentido
//     (anulada, recibido). Nunca se "des-anula" ni se "des-recibe".
function ajuste(clave, valor) {
  if (valor === undefined) {
    const r = db.prepare('SELECT valor FROM ajustes WHERE clave=?').get(clave);
    return r ? r.valor : null;
  }
  db.prepare('INSERT INTO ajustes (clave,valor) VALUES (?,?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor')
    .run(clave, valor);
  return valor;
}
function instalacionId() {
  return ajuste('instalacion') || ajuste('instalacion', require('crypto').randomUUID());
}

// Tablas que se sincronizan, con la columna por la que se sabe si algo es nuevo.
const TABLAS_SYNC = [
  { t: 'sitios',            marca: 'actualizado', modo: 'reciente' },
  { t: 'cargos',            marca: 'actualizado', modo: 'reciente' },
  { t: 'personas',          marca: 'actualizado', modo: 'reciente' },
  { t: 'productos',         marca: 'actualizado', modo: 'reciente' },
  { t: 'precios_sitio',     marca: 'actualizado', modo: 'reciente', clave: ['producto_id', 'sitio_id'] },
  // Las inversiones viajan con sus líneas. Los BORRADORES no
  // salen: mientras se están escribiendo cambian a cada rato, y una lista que
  // cambia no se puede juntar sin decidir quién gana. En cuanto se registran,
  // ya no cambian y viajan como todo lo demás.
  { t: 'inversiones',       marca: 'actualizado', modo: 'reciente',
    soloSi: "estado <> 'borrador'" },
  { t: 'inversion_lineas',  marca: null,          modo: 'ficha', clave: ['id'],
    soloSi: "inversion_id IN (SELECT id FROM inversiones WHERE estado <> 'borrador')",
    hijoDe: 'inversiones', padre: 'inversion_id' },
  { t: 'inversion_reparto', marca: null,          modo: 'ficha', clave: ['linea_id', 'sitio_id'],
    soloSi: "inversion_id IN (SELECT id FROM inversiones WHERE estado <> 'borrador')",
    hijoDe: 'inversiones', padre: 'inversion_id' },
  { t: 'movimientos',       marca: 'creado_en',   modo: 'apunte' },
  // Ojo con estas dos: anular una venta o recibir un traslado NO cambia la
  // fecha de creación. Si la marca mirara solo esa columna, esos cambios se
  // quedarían fuera del paquete y el otro lado nunca se enteraría. Hay que
  // mirar también la columna que se rellena después.
  { t: 'ventas',            marca: ['creado_en', 'anulada_en'], modo: 'venta' },
  { t: 'traslados',         marca: ['despachado_en', 'recibido_en'], modo: 'traslado' },
  { t: 'conteos',           marca: 'creado_en',   modo: 'apunte' },
  { t: 'fondo',             marca: 'creado_en',   modo: 'apunte' },
  { t: 'dias',              marca: null,          modo: 'dia',      clave: ['sitio_id', 'fecha'] },
  // Quiénes trabajaron cada día. Dueño único: el sitio donde se apunta. Gana la
  // versión más reciente, y como desmarcar a alguien es poner 'presente' en 0 y
  // no borrar la fila, el desmarcado viaja igual que el marcado.
  { t: 'dia_personas',      marca: 'actualizado', modo: 'reciente',
    clave: ['sitio_id', 'fecha', 'persona_id'] },
];

// Cómo se acota cada tabla a un sitio. Las que no salen aquí son del negocio
// entero (catálogo, personas, cargos) y viajan siempre completas: sin ellas, lo
// que se exporta no se entiende al abrirlo en otro lado.
const FILTRO_SITIO = {
  movimientos: 'sitio_id = ?', ventas: 'sitio_id = ?', dias: 'sitio_id = ?',
  conteos: 'sitio_id = ?', precios_sitio: 'sitio_id = ?', dia_personas: 'sitio_id = ?',
  traslados: '(origen_id = ? OR destino_id = ?)',
  // Los apuntes del fondo sin sitio son del negocio (retiros, inversiones):
  // dejarlos fuera sería exportar una contabilidad coja.
  fondo: '(sitio_id = ? OR sitio_id IS NULL)'
};

function paqueteDesde(marca, sitioId) {
  const datos = {};
  for (const d of TABLAS_SYNC) {
    const trozos = [], args = [];
    if (marca && d.marca) {
      const cols = Array.isArray(d.marca) ? d.marca : [d.marca];
      trozos.push('(' + cols.map(c => `COALESCE(${c},'') > ?`).join(' OR ') + ')');
      cols.forEach(() => args.push(marca));
    }
    if (sitioId && FILTRO_SITIO[d.t]) {
      trozos.push(FILTRO_SITIO[d.t]);
      const cuantos = (FILTRO_SITIO[d.t].match(/\?/g) || []).length;
      for (let i = 0; i < cuantos; i++) args.push(sitioId);
    }
    // Lo que no está terminado no viaja (los borradores). No lleva ningún
    // interrogante, así que no toca los argumentos.
    if (d.soloSi) trozos.push(d.soloSi);
    datos[d.t] = db.prepare(`SELECT * FROM ${d.t}` +
      (trozos.length ? ' WHERE ' + trozos.join(' AND ') : '')).all(...args);
  }
  const sitio = sitioId ? db.prepare('SELECT nombre FROM sitios WHERE id=?').get(sitioId) : null;
  return {
    dpadrones: 1,
    instalacion: instalacionId(),
    generado: ahoraISO(),
    desde: marca || null,
    sitio_id: sitioId || null,
    sitio: sitio ? sitio.nombre : 'Todos los sitios',
    datos
  };
}

function columnas(tabla) {
  return db.prepare(`PRAGMA table_info(${tabla})`).all().map(c => c.name);
}

function fusionar(paquete) {
  if (!paquete || paquete.dpadrones !== 1 || !paquete.datos)
    throw new Error('Ese archivo no es un paquete de D´Padrones');
  const cuenta = {};
  const tocados = {};      // qué padres cambiaron, para rehacer sus líneas
  db.transaction(() => {
    for (const d of TABLAS_SYNC) {
      const filas = paquete.datos[d.t] || [];
      if (!filas.length) continue;
      const cols = columnas(d.t);
      const usar = Object.keys(filas[0]).filter(c => cols.includes(c));
      const ph = usar.map(() => '?').join(',');
      const valores = f => usar.map(c => f[c] === undefined ? null : f[c]);
      let n = 0;

      if (d.modo === 'apunte') {
        // Inmutables: si ya está, no se toca. Por eso juntar dos veces no duplica.
        const ins = db.prepare(`INSERT OR IGNORE INTO ${d.t} (${usar.join(',')}) VALUES (${ph})`);
        for (const f of filas) n += ins.run(...valores(f)).changes;

      } else if (d.modo === 'reciente') {
        // Dueño único: gana la versión más reciente. Sin dueño único esto sería
        // exactamente el fallo que nos costó un día entero en La Inventería.
        const clave = d.clave || ['id'];
        const cond = clave.map(c => `${c}=?`).join(' AND ');
        const set = usar.filter(c => !clave.includes(c)).map(c => `${c}=?`).join(',');
        const ins = db.prepare(`INSERT OR IGNORE INTO ${d.t} (${usar.join(',')}) VALUES (${ph})`);
        const upd = db.prepare(`UPDATE ${d.t} SET ${set} WHERE ${cond} AND COALESCE(${d.marca},'') < ?`);
        for (const f of filas) {
          let cambio = ins.run(...valores(f)).changes;
          if (!cambio) cambio = upd.run(...usar.filter(c => !clave.includes(c)).map(c => f[c] ?? null),
                                        ...clave.map(c => f[c]), f[d.marca] || '').changes;
          n += cambio;
          // Se apunta qué padres se han movido: sus líneas hay que rehacerlas
          // enteras, o al cambiar una lista se quedarían mezcladas las de antes
          // con las de ahora.
          if (cambio) (tocados[d.t] = tocados[d.t] || new Set()).add(f.id);
        }

      } else if (d.modo === 'venta') {
        const ins = db.prepare(`INSERT OR IGNORE INTO ${d.t} (${usar.join(',')}) VALUES (${ph})`);
        const anular = db.prepare('UPDATE ventas SET anulada_en=? WHERE id=? AND anulada_en IS NULL');
        for (const f of filas) {
          n += ins.run(...valores(f)).changes;
          if (f.anulada_en) anular.run(f.anulada_en, f.id);   // anular solo avanza
        }

      } else if (d.modo === 'traslado') {
        const ins = db.prepare(`INSERT OR IGNORE INTO ${d.t} (${usar.join(',')}) VALUES (${ph})`);
        const recibir = db.prepare(`UPDATE traslados SET estado=?, recibido_en=?
            WHERE id=? AND recibido_en IS NULL`);
        for (const f of filas) {
          n += ins.run(...valores(f)).changes;
          if (f.recibido_en) recibir.run(f.estado, f.recibido_en, f.id);  // recibir solo avanza
        }

      } else if (d.modo === 'dia') {
        const ins = db.prepare(`INSERT OR IGNORE INTO dias (${usar.join(',')}) VALUES (${ph})`);
        const cerrar = db.prepare(`UPDATE dias SET cerrado_en=?, cerrado_por=?, efectivo=?,
            efectivo_usd=?, transfer=?, obs=? WHERE sitio_id=? AND fecha=? AND cerrado_en IS NULL`);
        for (const f of filas) {
          n += ins.run(...valores(f)).changes;
          if (f.cerrado_en) cerrar.run(f.cerrado_en, f.cerrado_por, f.efectivo,
                                       f.efectivo_usd || 0, f.transfer, f.obs, f.sitio_id, f.fecha);
        }

      } else if (d.modo === 'ficha') {
        // Las líneas de una inversión van con ella, que tiene dueño único.
        // Si el padre acaba de cambiar, sus líneas se rehacen enteras: quedarse
        // con las viejas y añadir las nuevas daría una lista que no existió
        // nunca, con productos repetidos o borrados que vuelven.
        if (d.hijoDe && tocados[d.hijoDe] && tocados[d.hijoDe].size) {
          const ids = [...tocados[d.hijoDe]];
          db.prepare(`DELETE FROM ${d.t} WHERE ${d.padre} IN (${huecos(ids.length)})`).run(...ids);
        }
        const ins = db.prepare(`INSERT OR IGNORE INTO ${d.t} (${usar.join(',')}) VALUES (${ph})`);
        for (const f of filas) n += ins.run(...valores(f)).changes;

      }
      if (n) cuenta[d.t] = n;
    }
  })();
  return cuenta;
}

// ─── PERSONAS, CARGOS Y PERMISOS ──────────────────────────────
// El administrador manda: es el único con '*'. Los demás cargos tienen la lista
// de permisos que él les ponga. Se comprueba EN EL SERVIDOR: esconder un botón
// no es seguridad, solo decoración.
// ─── EL CATÁLOGO DE PERMISOS ───────────────────────────────────
// Reescrito el 17 de agosto de 2026. El dueño: «necesito mejorar el sistema de
// permisos disponibles para poner a los roles, necesito permisos para todo lo que
// existe en la aplicación y con un sentido lógico», y «poder decidir qué puede y
// qué no puede hacer cada rol».
//
// Antes eran 15 permisos para 112 puertas, así que uno solo abría media
// aplicación: 'gestionar_dinero' daba a la vez ver la caja, mover dinero,
// corregir apuntes, pasar dinero entre cajas, las inversiones y pagar comisiones.
// No se podía tener a alguien que apunte gastos pero no toque las inversiones.
//
// La regla al partirlos: **VER y HACER son permisos distintos**, y lo que
// deshace algo va aparte de lo que lo hace. Un vendedor tiene que poder ver el
// catálogo sin poder editarlo; alguien puede cerrar la jornada sin poder
// reabrirla, que es donde se tapan los descuadres.
//
// 'area' agrupa la lista en la pantalla: cuarenta casillas seguidas no se leen.
// 'implica' es lo que se enciende solo al marcar uno, porque hacer algo sin poder
// verlo no sirve de nada (quien vende necesita ver el catálogo).
const PERMISOS = [
  // ── La caja ──
  { area: 'Caja y ventas', id: 'vender',        nombre: 'Usar la caja y cobrar',
    implica: ['ver_catalogo'] },
  { area: 'Caja y ventas', id: 'ver_ventas',    nombre: 'Ver las ventas del día y sus fichas' },
  { area: 'Caja y ventas', id: 'anular_venta',  nombre: 'Anular una venta ya cobrada',
    implica: ['ver_ventas'] },
  // ── El catálogo ──
  { area: 'Catálogo', id: 'ver_catalogo',       nombre: 'Ver los productos y lo que hay' },
  { area: 'Catálogo', id: 'gestionar_productos',nombre: 'Crear y editar productos',
    implica: ['ver_catalogo'] },
  { area: 'Catálogo', id: 'borrar_productos',   nombre: 'Dar de baja productos',
    implica: ['ver_catalogo'] },
  { area: 'Catálogo', id: 'precios',            nombre: 'Poner precios y excepciones por sitio',
    implica: ['ver_catalogo'] },
  { area: 'Catálogo', id: 'corregir_costos',    nombre: 'Repasar y corregir costos mal escritos',
    implica: ['ver_catalogo', 'ver_ganancias'] },
  // ── El almacén ──
  { area: 'Almacén', id: 'gestionar_inventario',nombre: 'Apuntar entradas y mermas',
    implica: ['ver_catalogo'] },
  { area: 'Almacén', id: 'traslados_enviar',    nombre: 'Despachar mercancía a otro sitio',
    implica: ['ver_catalogo'] },
  { area: 'Almacén', id: 'traslados_recibir',   nombre: 'Recibir y confirmar lo que llega',
    implica: ['ver_catalogo'] },
  { area: 'Almacén', id: 'ajustar_inventario',  nombre: 'Ajustar el inventario a lo contado',
    implica: ['ver_catalogo'] },
  // ── La jornada ──
  { area: 'La jornada', id: 'cerrar_dia',       nombre: 'Cerrar la jornada' },
  { area: 'La jornada', id: 'reabrir_dia',      nombre: 'Reabrir una jornada ya cerrada' },
  { area: 'La jornada', id: 'gente_del_dia',    nombre: 'Apuntar quién trabajó ese día' },
  // ── El dinero ──
  { area: 'Dinero', id: 'ver_fondo',            nombre: 'Ver la caja y sus movimientos' },
  { area: 'Dinero', id: 'mover_dinero',         nombre: 'Apuntar ingresos, retiros y gastos',
    implica: ['ver_fondo'] },
  { area: 'Dinero', id: 'corregir_dinero',      nombre: 'Corregir y anular apuntes de dinero',
    implica: ['ver_fondo'] },
  { area: 'Dinero', id: 'traspasos',            nombre: 'Pasar dinero de una caja a otra',
    implica: ['ver_fondo'] },
  { area: 'Dinero', id: 'ver_ganancias',        nombre: 'Ver costos y ganancias' },
  { area: 'Dinero', id: 'ver_informes',         nombre: 'Ver el resumen del período y sus PDF' },
  { area: 'Dinero', id: 'ver_negocio_entero',   nombre: 'Ver TODOS los sitios, no solo el suyo' },
  // ── Las comisiones ──
  { area: 'Comisiones', id: 'ver_comisiones',   nombre: 'Ver lo que le toca a cada trabajador' },
  { area: 'Comisiones', id: 'pagar_comisiones', nombre: 'Pagar comisiones y deshacer un pago',
    implica: ['ver_comisiones', 'ver_fondo'] },
  // ── Las inversiones ──
  { area: 'Inversiones', id: 'ver_inversiones', nombre: 'Ver las inversiones y su recuperación' },
  { area: 'Inversiones', id: 'gestionar_inversiones', nombre: 'Registrar y cancelar inversiones',
    implica: ['ver_inversiones', 'ver_catalogo'] },
  // ── La empresa ──
  { area: 'La empresa', id: 'gestionar_personas', nombre: 'Crear cargos y trabajadores' },
  { area: 'La empresa', id: 'gestionar_sitios', nombre: 'Crear almacenes y puntos de venta' },
  { area: 'La empresa', id: 'mi_empresa',       nombre: 'Nombre, logo y datos del certificado' },
  { area: 'La empresa', id: 'reglas_negocio',   nombre: 'Reglas: vender sin existencia, billetes' },
  { area: 'La empresa', id: 'copias',           nombre: 'Hacer y descargar copias de seguridad' },
  { area: 'La empresa', id: 'sincronizar',      nombre: 'Juntar la información de varios dispositivos' }
  // El valor del dólar, la moneda del negocio y borrar datos NO están en esta
  // lista a propósito: son solo del administrador y no se pueden dar a un cargo.
];

// Los 15 permisos viejos, y en qué se convierte cada uno. Sin esto, al desplegar
// esto todos los cargos existentes se quedarían con permisos que ya no existen y
// la gente perdería de golpe la mitad de la aplicación sin saber por qué. Se
// convierte hacia lo que YA PODÍAN hacer, ni más ni menos.
const PERMISOS_VIEJOS = {
  vender:              ['vender', 'ver_catalogo', 'ver_ventas'],
  anular_venta:        ['anular_venta', 'ver_ventas'],
  ver_ganancias:       ['ver_ganancias', 'ver_informes', 'ver_comisiones', 'ver_negocio_entero'],
  gestionar_productos: ['gestionar_productos', 'borrar_productos', 'precios',
                        'corregir_costos', 'ver_catalogo'],
  gestionar_inventario:['gestionar_inventario', 'ajustar_inventario', 'ver_catalogo',
                        'reglas_negocio'],
  traslados:           ['traslados_enviar', 'traslados_recibir', 'ver_catalogo'],
  cerrar_dia:          ['cerrar_dia', 'reabrir_dia', 'gente_del_dia', 'ajustar_inventario'],
  gestionar_dinero:    ['ver_fondo', 'mover_dinero', 'corregir_dinero', 'traspasos',
                        'ver_inversiones', 'gestionar_inversiones', 'pagar_comisiones',
                        'ver_comisiones'],
  gestionar_personas:  ['gestionar_personas', 'mi_empresa'],
  gestionar_sitios:    ['gestionar_sitios', 'copias'],
  sincronizar:         ['sincronizar']
};

// Lo que se enciende solo al marcar un permiso. Se resuelve en el servidor y no
// en la pantalla: un cargo guardado desde otro dispositivo con la versión vieja
// llegaría sin los implicados y quedaría a medias.
function conImplicados(lista) {
  const dentro = new Set(lista);
  let creciendo = true;
  while (creciendo) {
    creciendo = false;
    for (const p of PERMISOS)
      if (dentro.has(p.id)) for (const i of (p.implica || []))
        if (!dentro.has(i)) { dentro.add(i); creciendo = true; }
  }
  return [...dentro];
}

// Los cargos guardados con los 15 permisos viejos pasan a los nuevos. Corre UNA
// vez y deja su marca en 'ajustes': después, lo que diga el cargo es lo que el
// administrador haya decidido, y volver a traducir le desharía sus cambios en cada
// reinicio del servidor.
//
// Se traduce hacia lo que YA PODÍAN hacer, ni más ni menos: nadie gana un permiso
// que no tenía y, sobre todo, nadie lo pierde. Un cargo que se quedara con
// permisos que ya no existen dejaría a esa persona sin media aplicación de un día
// para otro y sin ninguna forma de entender por qué.
//
// No va dentro de initDB() porque desde allí este archivo todavía no ha declarado
// PERMISOS: se llama aquí, al cargar el módulo, que es después.
function migrarPermisos() {
  if (ajuste('permisos_v2')) return;
  const cargos = db.prepare("SELECT id, permisos FROM cargos WHERE permisos <> '*'").all();
  const upd = db.prepare('UPDATE cargos SET permisos=?, actualizado=? WHERE id=?');
  const ahora = ahoraISO();
  let tocados = 0;
  for (const c of cargos) {
    const viejos = String(c.permisos || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!viejos.length) continue;
    const nuevos = new Set();
    for (const v of viejos) {
      if (PERMISOS_VIEJOS[v]) PERMISOS_VIEJOS[v].forEach(n => nuevos.add(n));
      else if (PERMISOS.some(p => p.id === v)) nuevos.add(v);    // ya era del catálogo nuevo
    }
    const lista = conImplicados([...nuevos]).join(',');
    if (lista !== c.permisos) { upd.run(lista, ahora, c.id); tocados++; }
  }
  ajuste('permisos_v2', ahora);
  console.log('[migracion] ' + tocados + ' cargo(s) pasados al catálogo nuevo de permisos');
}
migrarPermisos();

const crypto = require('crypto');
// El PIN se escribe con el teclado NUMÉRICO del teléfono (inputmode="numeric"),
// así que solo pueden ser cifras. Se comprueba aquí y no solo en la pantalla:
// creando un usuario por la API se coló un PIN con letras que después era
// IMPOSIBLE de teclear en un móvil, y el usuario quedaba inservible sin que
// nada avisara. Pasó de verdad al montar la copia de internet.
const PIN_MAL = 'El PIN tiene que ser solo números, y al menos 4.';
const pinValido = pin => /^\d{4,}$/.test(String(pin == null ? '' : pin));

function hashPin(pin) {
  const sal = crypto.randomBytes(16).toString('hex');
  return sal + ':' + crypto.scryptSync(String(pin), sal, 32).toString('hex');
}
function pinCorrecto(pin, guardado) {
  if (!guardado || !guardado.includes(':')) return false;
  const [sal, h] = guardado.split(':');
  const calc = crypto.scryptSync(String(pin), sal, 32).toString('hex');
  const a = Buffer.from(h, 'hex'), b = Buffer.from(calc, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Freno de fuerza bruta. En La Inventería hubo que añadirlo después; aquí va
// desde el principio, que cuesta lo mismo.
const intentos = new Map();
function frenado(usuario) {
  const i = intentos.get(usuario);
  if (!i) return 0;
  if (i.hasta > Date.now()) return Math.ceil((i.hasta - Date.now()) / 1000);
  if (Date.now() - i.ultimo > 15 * 60 * 1000) intentos.delete(usuario);
  return 0;
}
function fallo(usuario) {
  const i = intentos.get(usuario) || { n: 0, hasta: 0, ultimo: 0 };
  i.n++; i.ultimo = Date.now();
  if (i.n >= 5) { i.hasta = Date.now() + 15 * 60 * 1000; i.n = 0; }
  intentos.set(usuario, i);
}

function permisosDe(persona) {
  if (!persona) return [];
  const c = db.prepare('SELECT permisos, es_admin FROM cargos WHERE id=?').get(persona.cargo_id);
  if (!c) return [];
  if (c.es_admin || c.permisos === '*') return ['*'];
  return String(c.permisos || '').split(',').map(s => s.trim()).filter(Boolean);
}
function puede(req, ...lista) {
  const p = req.permisos || [];
  if (p.includes('*')) return true;
  return lista.some(x => p.includes(x));
}
// El 403 dice QUÉ permiso falta y de quién. Sin eso, el administrador que se está
// haciendo pasar por un trabajador para ir armándole los permisos (#35) chocaría
// con un «no tienes permiso» y tendría que adivinar cuál de los cuarenta es. Con
// esto, la pantalla puede ofrecerle dárselo a ese cargo en el momento.
//
// Decir el nombre del permiso no abre ninguna puerta: la puerta la sigue guardando
// el servidor. Lo que evita es la conversación de «no me deja» / «¿qué te dice?».
function exige(...lista) {
  return (req, res, next) => {
    if (!req.persona) return res.status(401).json({ error: 'Hay que entrar con tu usuario' });
    if (puede(req, ...lista)) return next();
    const faltan = lista.filter(p => p !== '*')
      .map(id => ({ id, nombre: (PERMISOS.find(p => p.id === id) || {}).nombre || id }));
    const soloAdmin = lista.includes('*') && !faltan.length;
    res.status(403).json({
      error: soloAdmin ? SOLO_ADMIN
        : 'Falta el permiso «' + faltan.map(f => f.nombre).join('» o «') + '»',
      // A quién le falta: si se está actuando como otro, es de ESE de quien
      // hablamos, no del administrador que mira.
      falta: faltan,
      de_persona: req.comoPersona ? req.comoPersona.id : req.persona.id,
      de_cargo: (req.comoPersona || req.persona).cargo_id
    });
  };
}

// ─── EL FONDO ─────────────────────────────────────────────────
// Caja central del negocio. Entra lo de las ventas; sale lo de
// retiros, inversiones y gastos. Como todo lo demás, es una lista de apuntes
// que no se editan: corregir es meter el apunte contrario.
// Devuelve el id del apunte, que hace falta para poder referirse a él después
// sin tener que ir a buscarlo por la fecha, que es una forma estupenda de
// encontrar el apunte equivocado.
function apuntarFondo(a) {
  const ahora = ahoraISO();
  const id = nuevoId();
  db.prepare(`INSERT INTO fondo
      (id,tipo,subtipo,moneda,importe,sitio_id,persona_id,beneficiario_id,es_gente,concepto,
       ref_tipo,ref_id,anula_a,fecha,ts,creado_en)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, a.tipo, a.subtipo || null, a.moneda === 'USD' ? 'USD' : 'CUP',
         a.importe, a.sitio_id || null,
         a.persona_id || null, a.beneficiario_id || null, a.es_gente ? 1 : 0,
         a.concepto || '', a.ref_tipo || null, a.ref_id || null,
         a.anula_a || null,
         a.fecha || ahora.slice(0, 10), a.ts || Date.now(), ahora);
  return id;
}

// Un saldo por moneda. NO se suman entre si: mezclar CUP y USD daria un
// numero que no significa nada.
//
// Sin sitio es el FONDO GENERAL: todo el dinero del negocio, esté donde esté.
// Con un sitio es la gaveta de ese sitio: lo que ha entrado y salido allí. Los
// apuntes que no son de ningún sitio —retiros, inversiones, gastos del
// negocio— no se reparten entre los puntos, o la gaveta de cada uno dejaría de
// cuadrar con el dinero que hay dentro de verdad, que es para lo que sirve.
function saldoFondo(sitioId) {
  const filas = sitioId
    ? db.prepare(`SELECT moneda,
        COALESCE(SUM(CASE WHEN tipo='ingreso' THEN importe ELSE -importe END),0) saldo
        FROM fondo WHERE sitio_id=? GROUP BY moneda`).all(sitioId)
    : db.prepare(`SELECT moneda,
        COALESCE(SUM(CASE WHEN tipo='ingreso' THEN importe ELSE -importe END),0) saldo
        FROM fondo GROUP BY moneda`).all();
  const r = { CUP: 0, USD: 0 };
  filas.forEach(f => { r[f.moneda] = f.saldo; });
  return r;
}

// ─── NO SE SACA LO QUE NO HAY ─────────────────────────────────
// Pedido por el dueño el 21 de agosto de 2026: «no me puede retirar dinero del
// fondo si no existe el dinero, tiene que mostrarme un cartel de que no tengo
// ese dinero y prohibírmelo» (DECISIONES.md #38).
//
// Una gaveta en negativo no existe. Si sale, es que falta apuntar un dinero que
// entró o que alguien se equivocó de caja — y a partir de ahí ninguna cifra del
// fondo se puede creer, porque el saldo ya no es el dinero que hay dentro.
//
// El criterio va en UNA función porque lo usan cinco caminos —apuntar, corregir,
// registrar una inversión, pagar una comisión y el pase entre cajas—, y la vez
// que un criterio así se escribió dos veces, una de las copias se quedó sin él.
//
// Se mira POR MONEDA: tener 500 USD no da para pagar 500 CUP, son dos gavetas
// distintas. Y se mira el saldo de SIEMPRE, no el del período que esté abierto
// en la pantalla: el dinero de la caja no sabe de fechas.
//
// Devuelve el texto del error, o nada si hay con qué. El «consejo» es la salida
// que se le ofrece a quien se topa con esto, y cambia según de dónde venga: a
// quien pasa dinero de una caja a otra no se le puede aconsejar que lo pase de
// una caja a otra.
function faltaDinero(sitioId, moneda, importe, consejo) {
  const m = moneda === 'USD' ? 'USD' : 'CUP';
  const hay = saldoFondo(sitioId || undefined)[m];
  // Un pelo de margen: los saldos se guardan en coma flotante y sacar
  // exactamente lo que hay no puede fallar por una millonésima.
  if (Number(importe) <= hay + 0.0001) return null;
  const donde = sitioId
    ? 'En ' + ((db.prepare('SELECT nombre FROM sitios WHERE id=?').get(sitioId) || {}).nombre
        || 'esa caja')
    : 'En el fondo del negocio';
  return donde + ' hay ' + redondear(hay, m) + ' ' + m + ' y estás sacando ' +
    redondear(Number(importe), m) + ' ' + m + '. No se puede sacar dinero que no está. ' +
    (consejo || 'Si ese dinero lo pusiste tú o vino de fuera, apúntalo primero como ' +
     'Ingreso en esa caja; si está en otra, pásalo con una transferencia.');
}

// ─── EL GUARDIÁN DEL DÍA CERRADO ──────────────────────────────
// Un día cerrado no se toca (DECISIONES.md #5). En La Inventería se podía
// apuntar mercancía en un día ya cerrado: no llegaba al día siguiente Y ademas
// inflaba las ventas de ese día, porque se calculaban restando el conteo. Aquí
// no puede pasar, y no por disciplina: porque el servidor lo rechaza.
function diaCerrado(sitioId, fecha) {
  const d = db.prepare('SELECT cerrado_en FROM dias WHERE sitio_id=? AND fecha=?').get(sitioId, fecha);
  return !!(d && d.cerrado_en);
}
function siCerradoCortar(res, sitioId, fecha) {
  if (!diaCerrado(sitioId, fecha)) return false;
  res.status(409).json({
    error: 'El día ' + fecha + ' ya está cerrado en ese sitio. Para poder apuntar algo ' +
           'hay que reabrirlo desde la pantalla del día.'
  });
  return true;
}

// ─── Movimientos sueltos: entrada de mercancía, merma, ajuste ──
// Todos acaban en la misma tabla. Lo único que cambia es el signo y el motivo.
const TIPOS_SUELTOS = { compra: 1, devolucion: 1, merma: -1, ajuste: 0 };

app.post('/api/movimientos', exige('gestionar_inventario'), (req, res) => {
  const b = req.body || {};
  const signo = TIPOS_SUELTOS[b.tipo];
  if (signo === undefined) return res.status(400).json({ error: 'Tipo de movimiento no válido' });
  if (!b.sitio_id) return res.status(400).json({ error: 'Falta el sitio' });
  const prod = db.prepare('SELECT * FROM productos WHERE id=? AND borrado_en IS NULL').get(b.producto_id);
  if (!prod) return res.status(400).json({ error: 'Ese producto no existe' });

  const fechaMov = b.fecha || ahoraISO().slice(0, 10);
  if (b.tipo !== 'ajuste' && siCerradoCortar(res, b.sitio_id, fechaMov)) return;

  let cantidad = Number(b.cantidad);
  if (!cantidad || isNaN(cantidad)) return res.status(400).json({ error: 'Cantidad no válida' });
  // El ajuste puede ser en los dos sentidos y llega ya con su signo; los demás
  // lo tienen fijo, para que no dependa de que el aparato lo mande bien.
  if (signo !== 0) cantidad = Math.abs(cantidad) * signo;

  // No se da de baja lo que no está (DECISIONES.md #40). La merma es mercancía
  // que se perdió: si se pierden 3 y solo hay 2, una de dos, o la entrada de esa
  // mercancía no se apuntó o la cantidad está mal. Las dos se arreglan mirando,
  // y ninguna se arregla dejando el inventario en negativo.
  //
  // El ajuste también, cuando resta: es un conteo, y contar no puede dar menos
  // que nada. El del cierre del día nunca cae aquí, porque deja el estante
  // exactamente en lo contado.
  if (cantidad < 0) {
    const falta = faltaMercancia(
      [{ sitio_id: b.sitio_id, producto_id: prod.id, cantidad, nombre: prod.nombre, um: prod.um }],
      b.tipo === 'merma'
        ? 'Si esa mercancía llegó y no se apuntó, regístrala primero como entrada; y si ' +
          'se vendió o se usó en un trabajo, ya salió del inventario y no hay que darla de baja otra vez.'
        : 'Contar no puede dar menos que nada. Mira si falta por apuntar alguna entrada ' +
          'en ese sitio antes de ajustar.');
    if (falta) return res.status(400).json({ error: falta });
  }

  const costo = b.costo_unit != null ? Number(b.costo_unit) : prod.costo;
  const ahora = ahoraISO();
  const id = nuevoId();
  db.prepare(`INSERT INTO movimientos
      (id,tipo,sitio_id,aparato_id,persona_id,producto_id,cantidad,costo_unit,
       motivo,obs,fecha,ts,creado_en)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, b.tipo, b.sitio_id, b.aparato_id || null, b.persona_id || null,
         prod.id, cantidad, costo, b.motivo || null, b.obs || null,
         fechaMov, Date.now(), ahora);

  // Si la mercancía entró a otro precio, se actualiza el costo del producto.
  // El costo viejo no se pierde: cada movimiento guarda el suyo.
  if (b.tipo === 'compra' && b.actualizar_costo && costo > 0 && costo !== prod.costo) {
    db.prepare('UPDATE productos SET costo=?, actualizado=? WHERE id=?').run(costo, ahora, prod.id);
  }
  res.json({ ok: true, id });
});

// ─── Traslados: dos mitades con dueños distintos ──────────────
// El almacén registra que la mercancía SALIÓ; el punto registra lo que
// RECIBIÓ. Nadie corrige al otro (DECISIONES.md #3). Entre las dos mitades la
// mercancía está en tránsito, y a la vista.
app.post('/api/traslados', exige('traslados_enviar'), (req, res) => {
  const b = req.body || {};
  const lineas = Array.isArray(b.lineas) ? b.lineas : [];
  if (!b.origen_id || !b.destino_id) return res.status(400).json({ error: 'Faltan origen o destino' });
  if (b.origen_id === b.destino_id) return res.status(400).json({ error: 'El origen y el destino son el mismo sitio' });
  if (!lineas.length) return res.status(400).json({ error: 'El traslado no lleva productos' });

  const id = nuevoId(), ahora = ahoraISO(), ts = Date.now();
  const fecha = b.fecha || ahora.slice(0, 10);
  if (siCerradoCortar(res, b.origen_id, fecha)) return;
  const insMov = db.prepare(`INSERT INTO movimientos
      (id,tipo,sitio_id,producto_id,cantidad,costo_unit,ref_tipo,ref_id,obs,fecha,ts,creado_en)
      VALUES (?,'traslado_salida',?,?,?,?, 'traslado',?,?,?,?,?)`);
  try {
    db.transaction(() => {
      const pedidos = [];
      for (const l of lineas) {
        const prod = db.prepare('SELECT * FROM productos WHERE id=? AND borrado_en IS NULL').get(l.producto_id);
        if (!prod) throw new Error('Un producto del traslado ya no existe');
        const cant = Math.abs(Number(l.cantidad) || 0);
        if (!cant) throw new Error('Cantidad no válida');
        pedidos.push({ sitio_id: b.origen_id, producto_id: prod.id, cantidad: cant,
                       nombre: prod.nombre, um: prod.um, prod, cant });
      }
      // No se despacha lo que no está (#40). El freno va ANTES de escribir nada:
      // un traslado a medias deja mercancía en tránsito que no salió de ninguna
      // parte, y el que la recibe la apunta como si hubiera llegado.
      const falta = faltaMercancia(pedidos, 'Apunta primero la entrada de esa mercancía en ' +
        'el sitio del que sale, o despacha lo que haya de verdad.');
      if (falta) throw new Error(falta);

      db.prepare(`INSERT INTO traslados (id,origen_id,destino_id,estado,despachado_en,obs)
                  VALUES (?,?,?,'en_transito',?,?)`).run(id, b.origen_id, b.destino_id, ahora, b.obs || null);
      for (const { prod, cant } of pedidos)
        insMov.run(nuevoId(), b.origen_id, prod.id, -cant, prod.costo, id, b.obs || null, fecha, ts, ahora);
    })();
    res.json({ ok: true, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/traslados', exige('traslados_enviar', 'traslados_recibir'), (req, res) => {
  const sitio = req.query.sitio_id;
  if (!sitio) return res.status(400).json({ error: 'Falta el sitio' });
  const filas = db.prepare(`SELECT t.*, o.nombre origen, d.nombre destino
      FROM traslados t
      JOIN sitios o ON o.id=t.origen_id JOIN sitios d ON d.id=t.destino_id
      WHERE (t.origen_id=? OR t.destino_id=?) AND t.estado!='cancelado'
      ORDER BY t.despachado_en DESC LIMIT 60`).all(sitio, sitio);
  const lineas = db.prepare(`SELECT m.ref_id, m.tipo, m.producto_id, m.cantidad, m.costo_unit,
      p.nombre, p.codigo FROM movimientos m JOIN productos p ON p.id=m.producto_id
      WHERE m.ref_tipo='traslado'`).all();
  const porTraslado = {};
  lineas.forEach(l => (porTraslado[l.ref_id] = porTraslado[l.ref_id] || []).push(l));
  filas.forEach(t => {
    const ls = porTraslado[t.id] || [];
    t.enviado = ls.filter(l => l.tipo === 'traslado_salida')
                  .map(l => ({ ...l, cantidad: Math.abs(l.cantidad) }));
    t.recibido = ls.filter(l => l.tipo === 'traslado_entrada');
  });
  res.json({ traslados: filas });
});

// El punto confirma lo que recibió. Puede recibir MENOS: la diferencia queda a
// la vista como faltante en tránsito y no se toca el despacho del almacén.
app.post('/api/traslados/:id/recibir', exige('traslados_recibir'), (req, res) => {
  const t = db.prepare('SELECT * FROM traslados WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Ese traslado no existe' });
  if (t.estado !== 'en_transito') return res.status(400).json({ error: 'Ese traslado ya se recibió' });
  const lineas = Array.isArray(req.body && req.body.lineas) ? req.body.lineas : [];
  if (!lineas.length) return res.status(400).json({ error: 'No se indicó qué se recibió' });

  const enviado = db.prepare(`SELECT producto_id, SUM(-cantidad) cant, MAX(costo_unit) costo
      FROM movimientos WHERE ref_tipo='traslado' AND ref_id=? AND tipo='traslado_salida'
      GROUP BY producto_id`).all(t.id);
  const mapaEnv = {};
  enviado.forEach(e => { mapaEnv[e.producto_id] = e; });

  const ahora = ahoraISO(), ts = Date.now(), fecha = ahora.slice(0, 10);
  if (siCerradoCortar(res, t.destino_id, fecha)) return;
  const ins = db.prepare(`INSERT INTO movimientos
      (id,tipo,sitio_id,producto_id,cantidad,costo_unit,ref_tipo,ref_id,obs,fecha,ts,creado_en)
      VALUES (?,'traslado_entrada',?,?,?,?, 'traslado',?,?,?,?,?)`);
  let completo = true;
  try {
    db.transaction(() => {
      for (const l of lineas) {
        const env = mapaEnv[l.producto_id];
        if (!env) throw new Error('Ese producto no venía en el traslado');
        const cant = Math.abs(Number(l.cantidad) || 0);
        if (cant > env.cant) throw new Error('No se puede recibir más de lo que se despachó');
        if (cant < env.cant) completo = false;
        if (cant > 0) ins.run(nuevoId(), t.destino_id, l.producto_id, cant, env.costo,
                              t.id, req.body.obs || null, fecha, ts, ahora);
      }
      // Un producto que ni se menciona cuenta como no recibido
      if (lineas.length < enviado.length) completo = false;
      db.prepare('UPDATE traslados SET estado=?, recibido_en=? WHERE id=?')
        .run(completo ? 'recibido' : 'recibido_parcial', ahora, t.id);
    })();
    res.json({ ok: true, completo });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Cancelar solo mientras esté en tránsito. La mercancía vuelve al origen con
// los movimientos contrarios: no se borra nada.
app.post('/api/traslados/:id/cancelar', exige('traslados_enviar'), (req, res) => {
  const t = db.prepare('SELECT * FROM traslados WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Ese traslado no existe' });
  if (t.estado !== 'en_transito') return res.status(400).json({ error: 'Ya se recibió: no se puede cancelar' });
  const movs = db.prepare(
    "SELECT * FROM movimientos WHERE ref_tipo='traslado' AND ref_id=? AND tipo='traslado_salida'").all(t.id);
  const ahora = ahoraISO(), ts = Date.now();
  const ins = db.prepare(`INSERT INTO movimientos
      (id,tipo,sitio_id,producto_id,cantidad,costo_unit,ref_tipo,ref_id,anula_a,motivo,fecha,ts,creado_en)
      VALUES (?,'traslado_entrada',?,?,?,?, 'traslado',?,?,?,?,?,?)`);
  db.transaction(() => {
    for (const m of movs) {
      ins.run(nuevoId(), m.sitio_id, m.producto_id, -m.cantidad, m.costo_unit, t.id, m.id,
              'Traslado cancelado', m.fecha, ts, ahora);
    }
    db.prepare("UPDATE traslados SET estado='cancelado' WHERE id=?").run(t.id);
  })();
  res.json({ ok: true });
});

// ─── EL DÍA: cuadre y cierre ──────────────────────────────────
// Aquí NO hay ningún "inventario inicial" que copiar de un día al siguiente.
// El stock de cualquier momento es la suma de los movimientos hasta ese
// momento, así que el arrastre no puede fallar: no existe. Ese copiado a mano
// es lo que en La Inventería dejaba días enteros en cero.
function stockHasta(sitioId, fecha) {
  const filas = db.prepare(
    'SELECT producto_id, SUM(cantidad) c FROM movimientos WHERE sitio_id=? AND fecha<=? GROUP BY producto_id'
  ).all(sitioId, fecha);
  const m = {};
  filas.forEach(f => { m[f.producto_id] = f.c; });
  return m;
}

app.get('/api/dia', exige('ver_ventas', 'cerrar_dia', 'ver_informes'), (req, res) => {
  const sitio = req.query.sitio_id;
  const fecha = req.query.fecha || new Date().toISOString().slice(0, 10);
  if (!sitio) return res.status(400).json({ error: 'Falta el sitio' });

  const ventas = db.prepare(
    'SELECT * FROM ventas WHERE sitio_id=? AND fecha=? AND anulada_en IS NULL').all(sitio, fecha);
  // El EFECTIVO que entró va separado por moneda: sumar CUP con USD daría un
  // número sin significado, y al cerrar hay que contar cada gaveta por su lado.
  const porMoneda = { CUP: 0, USD: 0 };
  ventas.forEach(v => { porMoneda[v.moneda === 'USD' ? 'USD' : 'CUP'] += v.total; });
  // Lo VENDIDO, en cambio, se mide en la moneda del negocio, cada venta con el
  // cambio que tenía su día. Es la única forma de restarle el costo y que la
  // ganancia signifique algo (DECISIONES.md #21).
  const cuentas = enMonedaDelNegocio(ventas);

  const suma = (tipo, campo) => db.prepare(
    `SELECT COALESCE(SUM(${campo}),0) v FROM movimientos
     WHERE sitio_id=? AND fecha=? AND tipo=? AND anula_a IS NULL`).get(sitio, fecha, tipo).v;

  const verGan = puede(req, 'ver_ganancias');
  const dia = db.prepare('SELECT * FROM dias WHERE sitio_id=? AND fecha=?').get(sitio, fecha) || null;
  const conteos = dia && dia.cerrado_en
    ? db.prepare(`SELECT c.*, p.nombre, p.codigo FROM conteos c
                  JOIN productos p ON p.id=c.producto_id
                  WHERE c.sitio_id=? AND c.fecha=? AND c.contado != c.teorico`).all(sitio, fecha)
    : [];

  res.json({
    fecha,
    cerrado: !!(dia && dia.cerrado_en),
    dia,
    ventas: {
      cuenta: ventas.length,
      por_moneda: porMoneda,
      moneda_base: monedaBase(),
      // Todo lo vendido, puesto en la moneda del negocio.
      total: cuentas.vendido,
      costo: verGan ? cuentas.costo : null,
      ganancia: verGan ? cuentas.ganancia : null,
      // Si alguna venta necesitaba el cambio y no lo había, se dice: mejor un
      // aviso que una ganancia que se ha comido una venta entera sin avisar.
      sin_tasa: cuentas.sin_tasa,
      comision: ventas.reduce((s, v) => s + v.comision, 0)
    },
    // Lo que cuesta la gente ese día y lo que queda después. La «ganancia» de
    // arriba sigue siendo la de siempre —lo vendido menos la mercancía—, para que
    // ninguna cifra que el dueño ya conoce cambie de valor de un día para otro.
    personal: verGan ? (() => {
      const sueldos = pagosALaGente(fecha, fecha, sitio);
      const com = ventas.reduce((s, v) => s + v.comision, 0);
      return { comision: redondear(com, monedaBase()), sueldos: sueldos.total,
               queda: redondear(cuentas.ganancia - com - sueldos.total, monedaBase()),
               sin_tasa: sueldos.sin_tasa };
    })() : null,
    // Las compras entran con cantidad positiva y las mermas negativa: de ahí
    // que una se lea tal cual y a la otra haya que cambiarle el signo.
    compras: { valor: verGan ? suma('compra', 'cantidad * costo_unit') : null,
               unidades: suma('compra', 'cantidad') },
    mermas:  { valor: verGan ? -suma('merma', 'cantidad * costo_unit') : null,
               unidades: -suma('merma', 'cantidad') },
    traslados: {
      salidas: -suma('traslado_salida', 'cantidad'),
      entradas: suma('traslado_entrada', 'cantidad')
    },
    ajustes: suma('ajuste', 'cantidad'),
    conteos_con_diferencia: conteos,
    // Quiénes trabajaron, para las casillas del cierre y para poder decir en la
    // pantalla entre cuántos se va a repartir la comisión de ese día.
    gente: gentePosible(sitio),
    trabajaron: presentesDe(sitio, fecha)
  });
});

// ─── QUIÉNES TRABAJARON ESE DÍA ───────────────────────────────
// Pedido por el dueño el 17 de agosto de 2026, y cambia de raíz a quién se le
// atribuye la comisión: hasta ahora era de quien marcó la venta, y en el
// mostrador la marca quien tiene el teléfono en la mano. Ahora la comisión del
// día se reparte a partes iguales entre los que estuvieron (DECISIONES.md #32).
//
// Los nombres se mandan desde aquí y no se leen de /api/personas porque esa
// pantalla pide permiso para gestionar personal: quien cierra el día muchas
// veces no lo tiene, y se habría quedado mirando una lista de casillas sin
// nombre. Va lo justo para pintarlas: el id y el nombre.
function gentePosible(sitio) {
  return db.prepare(`SELECT id, nombre, sitio_id FROM personas
      WHERE activo=1 ORDER BY (sitio_id IS NOT ?) , nombre`).all(sitio);
}
function presentesDe(sitio, fecha) {
  return db.prepare(`SELECT persona_id FROM dia_personas
      WHERE sitio_id=? AND fecha=? AND presente=1`).all(sitio, fecha).map(f => f.persona_id);
}

// Guardar la lista. Se puede tocar mientras el día esté abierto; en un día ya
// cerrado solo el administrador, y esto merece explicación: la regla #5 dice que
// un día cerrado no se toca, pero olvidarse de marcar a alguien significa que
// esa persona NO COBRA, y la alternativa —reabrir la jornada— es peor, porque un
// día reabierto vuelve a aceptar ventas y mercancía con esa fecha. Cambiar la
// lista no mueve ni una unidad de inventario ni un peso de la caja: solo cambia
// entre cuántos se divide una comisión que todavía no se ha pagado.
app.post('/api/dias/personas', exige('gente_del_dia'), (req, res) => {
  const b = req.body || {};
  const sitio = b.sitio_id, fecha = b.fecha;
  if (!sitio || !fecha) return res.status(400).json({ error: 'Faltan el sitio o la fecha' });
  if (diaCerrado(sitio, fecha) && !puede(req, '*')) return res.status(400).json({
    error: 'Ese día ya está cerrado. Solo el administrador puede cambiar quién trabajó.' });
  const ids = Array.isArray(b.personas) ? b.personas.map(String) : [];
  const validas = new Set(gentePosible(sitio).map(p => p.id));
  guardarPresentes(sitio, fecha, ids.filter(i => validas.has(i)));
  res.json({ ok: true, presentes: presentesDe(sitio, fecha) });
});

// Marcar y desmarcar en una transacción. Desmarcar es poner 'presente' en 0 y NO
// borrar la fila: una fila que desaparece no viaja en la sincronización, y al
// juntar dos aparatos la persona desmarcada volvería del otro lado.
function guardarPresentes(sitio, fecha, ids) {
  const ahora = ahoraISO();
  const poner = db.prepare(`INSERT INTO dia_personas (sitio_id,fecha,persona_id,presente,actualizado)
      VALUES (?,?,?,?,?)
      ON CONFLICT(sitio_id,fecha,persona_id) DO UPDATE SET
        presente=excluded.presente, actualizado=excluded.actualizado
      WHERE presente <> excluded.presente`);
  db.transaction(() => {
    const antes = db.prepare('SELECT persona_id FROM dia_personas WHERE sitio_id=? AND fecha=?')
      .all(sitio, fecha).map(f => f.persona_id);
    const quiero = new Set(ids);
    for (const id of quiero) poner.run(sitio, fecha, id, 1, ahora);
    for (const id of antes) if (!quiero.has(id)) poner.run(sitio, fecha, id, 0, ahora);
  })();
}

// Stock teórico a una fecha, para el conteo físico del cierre
app.get('/api/dia/teorico', exige('cerrar_dia', 'ajustar_inventario'), (req, res) => {
  const sitio = req.query.sitio_id;
  const fecha = req.query.fecha || new Date().toISOString().slice(0, 10);
  if (!sitio) return res.status(400).json({ error: 'Falta el sitio' });
  res.json({ teorico: stockHasta(sitio, fecha) });
});

// Cerrar el día. El conteo físico sirve para DETECTAR descuadres; ajustarlos es
// una decisión aparte, y si se ajusta se hace con un movimiento de tipo
// 'ajuste' que queda en el historial. Nunca reescribiendo un número.
app.post('/api/dias/cerrar', exige('cerrar_dia'), (req, res) => {
  const b = req.body || {};
  const sitio = b.sitio_id;
  const fecha = b.fecha;
  if (!sitio || !fecha) return res.status(400).json({ error: 'Faltan el sitio o la fecha' });
  if (diaCerrado(sitio, fecha)) return res.status(400).json({ error: 'Ese día ya estaba cerrado' });

  const teorico = stockHasta(sitio, fecha);
  const conteos = Array.isArray(b.conteos) ? b.conteos : [];
  const ahora = ahoraISO(), ts = Date.now();

  const insConteo = db.prepare(`INSERT INTO conteos (id,sitio_id,fecha,producto_id,contado,teorico,creado_en)
      VALUES (?,?,?,?,?,?,?)`);
  const insAjuste = db.prepare(`INSERT INTO movimientos
      (id,tipo,sitio_id,producto_id,cantidad,costo_unit,motivo,fecha,ts,creado_en)
      VALUES (?,'ajuste',?,?,?,?,?,?,?,?)`);

  // Contar no puede dar menos que nada (#40), y se mira ANTES de empezar: un
  // conteo en negativo entraría como ajuste y dejaría el estante debiendo
  // mercancía, con el día ya cerrado encima.
  const enNegativo = conteos.find(c => Number(c.contado) < 0);
  if (enNegativo) {
    const prod = db.prepare('SELECT nombre FROM productos WHERE id=?').get(enNegativo.producto_id);
    return res.status(400).json({ error: 'El conteo de «' +
      ((prod && prod.nombre) || 'un producto') + '» está en negativo. Lo que no está se ' +
      'cuenta como cero, no como menos.' });
  }

  let diferencias = 0, ajustados = 0;
  db.transaction(() => {
    for (const c of conteos) {
      const t = Number(teorico[c.producto_id] || 0);
      const contado = Number(c.contado);
      if (isNaN(contado)) continue;
      insConteo.run(nuevoId(), sitio, fecha, c.producto_id, contado, t, ahora);
      if (contado !== t) {
        diferencias++;
        if (b.ajustar) {
          const prod = db.prepare('SELECT costo FROM productos WHERE id=?').get(c.producto_id);
          insAjuste.run(nuevoId(), sitio, c.producto_id, contado - t, prod ? prod.costo : 0,
                        'Ajuste del cierre del ' + fecha, fecha, ts, ahora);
          ajustados++;
        }
      }
    }
    db.prepare(`INSERT INTO dias (sitio_id,fecha,cerrado_en,cerrado_por,efectivo,efectivo_usd,transfer,obs)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(sitio_id,fecha) DO UPDATE SET cerrado_en=excluded.cerrado_en,
          cerrado_por=excluded.cerrado_por, efectivo=excluded.efectivo,
          efectivo_usd=excluded.efectivo_usd, transfer=excluded.transfer, obs=excluded.obs`)
      .run(sitio, fecha, ahora, b.cerrado_por || null, Number(b.efectivo) || 0,
           Number(b.efectivo_usd) || 0, Number(b.transfer) || 0, b.obs || null);
    // Quiénes trabajaron, dentro de la MISMA transacción que el cierre: si algo
    // fallara a medias, no puede quedar un día cerrado con una lista de gente a
    // medio guardar, que es entre quiénes se reparte el dinero.
    if (Array.isArray(b.personas)) {
      const validas = new Set(gentePosible(sitio).map(p => p.id));
      guardarPresentes(sitio, fecha, b.personas.map(String).filter(i => validas.has(i)));
    }
  })();

  res.json({ ok: true, diferencias, ajustados });
});

// Reabrir queda registrado: no es lo mismo un día que nunca se cerró que uno
// que se cerró y se volvió a abrir.
app.post('/api/dias/reabrir', exige('reabrir_dia'), (req, res) => {
  const b = req.body || {};
  if (!b.sitio_id || !b.fecha) return res.status(400).json({ error: 'Faltan el sitio o la fecha' });
  const d = db.prepare('SELECT * FROM dias WHERE sitio_id=? AND fecha=?').get(b.sitio_id, b.fecha);
  if (!d || !d.cerrado_en) return res.status(400).json({ error: 'Ese día no está cerrado' });
  const nota = 'Reabierto el ' + ahoraISO() + (d.obs ? ' — ' + d.obs : '');
  db.prepare('UPDATE dias SET cerrado_en=NULL, obs=? WHERE sitio_id=? AND fecha=?')
    .run(nota, b.sitio_id, b.fecha);
  res.json({ ok: true });
});

// ─── Fondo: consultar y apuntar a mano ────────────────────────
app.get('/api/fondo', exige('ver_fondo'), (req, res) => {
  const desde = req.query.desde || '0000-01-01';
  const hasta = req.query.hasta || '9999-12-31';
  // Un apunte anulado y su anulación son un par que suma cero. En las CUENTAS
  // siguen contando los dos —por eso ninguna consulta de aquí abajo los
  // aparta—, pero en la LISTA estorban: quien corrigió un error quiere ver la
  // corrección, no el error, la corrección y la resta. Con «anulados=1» salen,
  // que el histórico está entero y hay que poder mirarlo.
  const ocultarAnulados = req.query.anulados
    ? '' : ` AND f.anula_a IS NULL
             AND NOT EXISTS (SELECT 1 FROM fondo x WHERE x.anula_a = f.id)`;
  // Quien solo manda en su tienda ve el dinero de su tienda y nada más: ni los
  // apuntes de las otras cajas, ni los que no son de ningún sitio (#39). El
  // filtro entra en TODAS las consultas de esta puerta —lista, resumen, gavetas
  // y saldo—, porque dejar una sin él enseñaría por un lado lo que se tapa por
  // el otro, y ese es el peor resultado posible: la mitad de la verdad.
  const soloSuyos = idsQueVe(req);
  const enSitios = c => soloSuyos ? ` AND ${c} IN (${soloSuyos.map(() => '?').join(',')})` : '';
  const conSitios = (...a) => soloSuyos ? a.concat(soloSuyos) : a;
  const filas = db.prepare(`SELECT f.*, s.nombre sitio,
      EXISTS (SELECT 1 FROM fondo x WHERE x.anula_a = f.id) anulado FROM fondo f
      LEFT JOIN sitios s ON s.id=f.sitio_id
      WHERE f.fecha BETWEEN ? AND ?${enSitios('f.sitio_id')}${ocultarAnulados}
      ORDER BY f.ts DESC LIMIT 200`).all(...conSitios(desde, hasta));
  // Los TRASPASOS entre sitios no son dinero que entre ni salga del negocio:
  // es el mismo dinero cambiado de gaveta. Si contaran, un traspaso de 100
  // aparecería como 100 de ingresos y 100 de retiros, y el resumen del mes
  // diría que entró dinero que no entró.
  const porTipo = db.prepare(`SELECT tipo, moneda, COALESCE(SUM(importe),0) total FROM fondo
      WHERE fecha BETWEEN ? AND ?${enSitios('sitio_id')}
        AND COALESCE(ref_tipo,'') <> 'traspaso'
      GROUP BY tipo, moneda`).all(...conSitios(desde, hasta));
  const resumen = { CUP: { ingreso: 0, retiro: 0, inversion: 0, gasto: 0 },
                    USD: { ingreso: 0, retiro: 0, inversion: 0, gasto: 0 } };
  porTipo.forEach(t => { resumen[t.moneda === 'USD' ? 'USD' : 'CUP'][t.tipo] = t.total; });
  // De dónde salió el dinero que entró: el fondo cuenta también lo que sigue
  // en la gaveta de cada punto, así que conviene verlo repartido.
  const porSitio = db.prepare(`SELECT COALESCE(s.nombre,'Sin sitio') sitio, f.moneda,
      COALESCE(SUM(f.importe),0) total FROM fondo f LEFT JOIN sitios s ON s.id=f.sitio_id
      WHERE f.tipo='ingreso' AND COALESCE(f.ref_tipo,'') <> 'traspaso'
        AND f.fecha BETWEEN ? AND ?${enSitios('f.sitio_id')}
      GROUP BY f.sitio_id, f.moneda
      ORDER BY total DESC`).all(...conSitios(desde, hasta));
  // La gaveta de cada sitio, que es un SALDO de siempre y no un flujo del
  // período. Va aparte por eso: meter un saldo dentro de un período daría un
  // número que no es ni lo uno ni lo otro (DECISIONES.md #22).
  const gavetas = new Map();
  for (const g of db.prepare(`SELECT f.sitio_id, s.nombre sitio, f.moneda,
      COALESCE(SUM(CASE WHEN f.tipo='ingreso' THEN f.importe ELSE -f.importe END),0) saldo
      FROM fondo f LEFT JOIN sitios s ON s.id=f.sitio_id
      ${soloSuyos ? 'WHERE 1=1' + enSitios('f.sitio_id') : ''}
      GROUP BY f.sitio_id, f.moneda`).all(...(soloSuyos || []))) {
    const k = g.sitio_id || '';
    if (!gavetas.has(k)) gavetas.set(k, { sitio_id: g.sitio_id,
      sitio: g.sitio || 'De la empresa (sin sitio)', CUP: 0, USD: 0 });
    gavetas.get(k)[g.moneda === 'USD' ? 'USD' : 'CUP'] = g.saldo;
  }
  const sitio = req.query.sitio || null;
  // «saldo» es lo que se enseña como el dinero de la empresa. Para quien solo ve
  // su tienda, la empresa que puede ver es su tienda: enseñarle el fondo general
  // sería justo lo que se está tapando en las demás cifras. Va marcado con
  // «ver_todo» para que la pantalla no lo titule «Fondo general de la empresa»
  // cuando no lo es.
  res.json({ saldo: saldoVisible(req), saldo_sitio: sitio ? saldoFondo(sitio) : null,
             sitio_id: sitio, ver_todo: !soloSuyos, gavetas: [...gavetas.values()],
             resumen, por_sitio: porSitio, movimientos: filas });
});

// El dinero que SALE tiene que decir de qué caja (DECISIONES.md #37). Devuelve el
// texto del error, o nada si está bien. En una función porque lo comprueban dos
// caminos —apuntar y corregir— y la vez que un criterio así se escribió dos veces,
// una de las dos copias se quedó sin él.
//
// Un INGRESO a mano sigue pudiendo no tener sitio: un aporte de un socio puede no
// entrar por ninguna tienda. Y los apuntes VIEJOS sin sitio no se tocan: el pasado
// no se reescribe (#2), así que la fila «De la empresa» sigue existiendo con lo de
// antes y sumando lo que sumaba.
const SALE_DE_UNA_CAJA = ['retiro', 'gasto', 'inversion'];
function sitioDelApunte(b) {
  if (!SALE_DE_UNA_CAJA.includes(b.tipo)) return null;
  if (!b.sitio_id) return 'Di de qué caja sale el dinero. Sin eso, la gaveta de ese ' +
    'sitio seguiría diciendo que tiene un dinero que ya no está.';
  if (!db.prepare('SELECT 1 FROM sitios WHERE id=?').get(String(b.sitio_id)))
    return 'Ese sitio no está en esta copia';
  return null;
}

app.post('/api/fondo', exige('mover_dinero'), (req, res) => {
  const b = req.body || {};
  if (!['ingreso', 'retiro', 'inversion', 'gasto'].includes(b.tipo))
    return res.status(400).json({ error: 'Tipo no válido' });
  const importe = Number(b.importe);
  if (!importe || importe <= 0) return res.status(400).json({ error: 'El importe tiene que ser mayor que cero' });
  // "Siempre se debe declarar cuando se toma un dinero para inversión qué tipo
  // de inversión es". Sin subtipo no pasa.
  if (b.tipo === 'inversion' && !b.subtipo)
    return res.status(400).json({ error: 'Toda inversión tiene que declarar de qué tipo es' });
  // Y DE QUÉ CAJA SALE, cuando es dinero que sale (DECISIONES.md #37). Pedido por el
  // dueño el 17 de agosto de 2026: «tanto en retiro como en inversiones y gasto
  // necesito que donde dice sitio opcional sea obligatorio».
  const fuera = sitioDelApunte(b);
  if (fuera) return res.status(400).json({ error: fuera });
  // Y ese dinero tiene que ESTAR en esa caja (DECISIONES.md #38).
  if (SALE_DE_UNA_CAJA.includes(b.tipo)) {
    const sinFondo = faltaDinero(b.sitio_id || null, b.moneda, importe);
    if (sinFondo) return res.status(400).json({ error: sinFondo });
  }
  // Ojo: una inversión EN MERCANCÍA no se apunta aquí, sino en su pantalla, con
  // la lista de lo que se compró. Esto es para el otro tipo de inversión —una
  // camioneta, un local, herramientas—, que no se recupera vendiendo unidades y
  // por eso no lleva productos ni porcentaje.
  apuntarFondo({
    tipo: b.tipo, subtipo: b.subtipo || null, moneda: b.moneda, importe,
    sitio_id: b.sitio_id || null,
    // Quién lo apuntó. Se coge de la sesión y no de lo que mande el aparato: la
    // ficha del apunte dice «Registrado por» y hasta ahora salía siempre un
    // guion, porque nadie rellenaba este campo. Ahora que un apunte se puede
    // corregir y anular, saber de quién es deja de ser un adorno.
    persona_id: b.persona_id || req.persona.id,
    // Si esto es dinero para la gente —un salario, un adelanto—, se marca, y
    // entonces se resta de la ganancia en los desgloses (#33). Solo tiene sentido
    // en el dinero que SALE: un ingreso marcado así descuadraría la cuenta.
    es_gente: (b.tipo === 'retiro' || b.tipo === 'gasto') && b.es_gente ? 1 : 0,
    beneficiario_id: b.beneficiario_id || null,
    concepto: b.concepto || '', fecha: b.fecha || undefined
  });
  res.json({ ok: true, saldo: saldoVisible(req) });
});

// ─── Corregir y anular un apunte hecho a mano ─────────────────
// Pedido por el dueño el 16 de agosto de 2026: «necesito poder editar y borrar
// los retiros, ingresos y gastos». Va contra la decisión #2 —los apuntes no se
// tocan— y por eso no se tocan de verdad: está explicado en la #31.
//
// Anular es meter el MISMO tipo de apunte con el importe en negativo. Parece un
// rodeo y es justo lo contrario: todas las cuentas del negocio —el saldo, la
// caja de cada sitio, el resumen por tipo, el mirador del almacén— suman el
// importe y le ponen el signo según el tipo. Un negativo del mismo tipo se
// cancela solo en TODAS ellas sin tocar una sola consulta. Con el apunte del
// tipo contrario el saldo también habría cuadrado, pero el mes habría salido
// con un ingreso y un retiro que nunca existieron, que es el mismo enredo que
// obligó a apartar los traspasos.
//
// Solo se puede con los apuntes hechos A MANO. Los que vienen de una venta, de
// una inversión, de un trabajo o de un traspaso tienen otro dueño (#3): si se
// borrara aquí el dinero de una venta, el fondo diría una cosa y la venta otra.
// Esos se deshacen donde se hicieron, y se dice dónde.
function apunteQueSePuedeTocar(id) {
  const a = db.prepare('SELECT * FROM fondo WHERE id=?').get(String(id));
  if (!a) return { error: 'Ese apunte no está en esta copia', codigo: 404 };
  const de = {
    venta: 'Este dinero entró por una venta. Para quitarlo, anula la venta en Cierre: ' +
           'el fondo se corrige solo.',
    inversion: 'Este dinero salió de una inversión. Para quitarlo, cancela la inversión ' +
               'en Dinero → Inversiones.',
    traspaso: 'Esto es un pase de dinero de una caja a otra, y tiene dos mitades. ' +
              'Para deshacerlo, haz el pase al revés.',
    comision: 'Este es el pago de una comisión. Se deshace donde se hizo: ' +
              'Dinero → Comisiones.'
  };
  if (a.ref_tipo) return { error: de[a.ref_tipo] ||
    'Este apunte lo creó otra operación y se corrige allí.', codigo: 400 };
  if (a.anula_a) return { error: 'Esto es la anulación de otro apunte. Anular una ' +
    'anulación dejaría el histórico ilegible.', codigo: 400 };
  if (db.prepare('SELECT 1 FROM fondo WHERE anula_a=?').get(a.id))
    return { error: 'Ese apunte ya está anulado', codigo: 400 };
  return { apunte: a };
}

// El apunte contrario. La fecha es la DEL ORIGINAL a propósito, no la de hoy:
// esto no es un hecho nuevo, es la corrección de un error. Con la fecha de hoy,
// el mes en el que se apuntó mal se quedaría descuadrado para siempre y el de
// ahora arrastraría un dinero que no se movió. Lo que sí queda con la hora de
// ahora es 'creado_en', que es lo que cuenta cuándo se corrigió.
function anularApunte(a, quien) {
  return apuntarFondo({
    tipo: a.tipo, subtipo: a.subtipo, moneda: a.moneda, importe: -a.importe,
    sitio_id: a.sitio_id, persona_id: quien,
    concepto: 'Anulación de: ' + (a.concepto || a.subtipo || a.tipo),
    beneficiario_id: a.beneficiario_id,
    // Y si el apunte era dinero para la gente, su anulación también lo es. Sin
    // esto, anular un salario mal apuntado dejaría el negativo fuera de la suma
    // y ese salario seguiría restándose de la ganancia para siempre (#33).
    es_gente: a.es_gente,
    // De qué venía el apunte se COPIA en su anulación. Hasta los pagos de
    // comisión esto no hacía falta —solo se anulaban apuntes hechos a mano, que
    // no vienen de nada—, pero lo pagado a una persona se cuenta sumando los
    // apuntes con ref_tipo='comision' de ese mes: si la anulación no lo llevara,
    // quedaría fuera de esa suma y la app seguiría diciendo que se le pagó un
    // dinero que se acabó de devolver.
    ref_tipo: a.ref_tipo, ref_id: a.ref_id,
    anula_a: a.id, fecha: a.fecha
  });
}

app.post('/api/fondo/:id/anular', exige('corregir_dinero'), (req, res) => {
  const r = apunteQueSePuedeTocar(req.params.id);
  if (r.error) return res.status(r.codigo).json({ error: r.error });
  anularApunte(r.apunte, req.persona.id);
  res.json({ ok: true, saldo: saldoVisible(req) });
});

// Corregir es anular y volver a apuntar, las dos cosas o ninguna. En la lista
// se ve el apunte bueno y ya está; el malo y su anulación quedan debajo, para
// quien quiera mirar los anulados.
app.post('/api/fondo/:id/corregir', exige('corregir_dinero'), (req, res) => {
  const r = apunteQueSePuedeTocar(req.params.id);
  if (r.error) return res.status(r.codigo).json({ error: r.error });
  const b = req.body || {}, viejo = r.apunte;
  const tipo = b.tipo || viejo.tipo;
  if (!['ingreso', 'retiro', 'inversion', 'gasto'].includes(tipo))
    return res.status(400).json({ error: 'Tipo no válido' });
  const importe = Number(b.importe);
  if (!importe || importe <= 0)
    return res.status(400).json({ error: 'El importe tiene que ser mayor que cero' });
  const subtipo = b.subtipo === undefined ? viejo.subtipo : (b.subtipo || null);
  if (tipo === 'inversion' && !subtipo)
    return res.status(400).json({ error: 'Toda inversión tiene que declarar de qué tipo es' });
  // Al corregir también hay que decir de qué caja sale (#37). Se mira el sitio que
  // vaya a quedar: si no se manda, el que ya tenía. Un apunte viejo sin sitio que se
  // corrige tiene que elegir uno ahora, y eso es lo correcto — corregirlo es la
  // ocasión de arreglarlo.
  const sitioFinal = b.sitio_id === undefined ? viejo.sitio_id : (b.sitio_id || null);
  const fuera = sitioDelApunte({ tipo, sitio_id: sitioFinal });
  if (fuera) return res.status(400).json({ error: fuera });
  const monedaFinal = b.moneda === 'USD' || b.moneda === 'CUP' ? b.moneda : viejo.moneda;
  let nuevo;
  try {
  db.transaction(() => {
    anularApunte(viejo, req.persona.id);
    // Con el apunte malo YA DESHECHO se mira si queda dinero para el bueno (#38):
    // corregir un retiro de 100 por uno de 150 saca 50 más, no 150, y mirarlo antes
    // de anular lo contaría dos veces. Si no llega, la excepción tumba la
    // transacción entera y la anulación se va con ella — dejarla escrita sin el
    // apunte bueno sería borrar el error en vez de corregirlo.
    if (SALE_DE_UNA_CAJA.includes(tipo)) {
      const sinFondo = faltaDinero(sitioFinal, monedaFinal, importe);
      if (sinFondo) throw new Error(sinFondo);
    }
    nuevo = apuntarFondo({
      tipo, subtipo, moneda: monedaFinal, importe,
      sitio_id: sitioFinal,
      persona_id: req.persona.id,
      // La marca de «dinero para la gente» se conserva si no se dice otra cosa, y
      // se puede cambiar al corregir: es justo lo que hace falta el día que un
      // gasto se apuntó sin marcar y hay que arreglarlo. Solo vale en las salidas.
      es_gente: (tipo === 'retiro' || tipo === 'gasto')
        && (b.es_gente === undefined ? !!viejo.es_gente : !!b.es_gente) ? 1 : 0,
      beneficiario_id: b.beneficiario_id === undefined
        ? viejo.beneficiario_id : (b.beneficiario_id || null),
      concepto: b.concepto === undefined ? viejo.concepto : String(b.concepto || ''),
      fecha: b.fecha || viejo.fecha
    });
  })();
  } catch (e) { return res.status(400).json({ error: e.message }); }
  res.json({ ok: true, id: nuevo, saldo: saldoVisible(req) });
});

// ═══════════════════════════════════════════════════════════════
//  LOS AVISOS
// ═══════════════════════════════════════════════════════════════
// Lo que ha pasado y todavía no ha atendido nadie.
//
// NO hay una tabla de avisos, y es a propósito. Un aviso no es un dato nuevo:
// es una forma de mirar los datos que ya hay. Con una tabla aparte habría dos
// verdades —la lista de avisos y el estado de verdad— y en cuanto se
// desincronizaran, la campanita estaría avisando de algo que alguien ya
// atendió (DECISIONES.md #1: nada que se pueda calcular se guarda).
//
// Hoy todo lo que se avisa lo sabe el APARATO —mercancía agotándose, versión
// nueva—, así que esta lista sale vacía. Se queda porque el sitio que la pinta
// ya está hecho: cuando haya algo que solo sepa el servidor, se añade aquí y
// aparece solo en la campanita.
app.get('/api/avisos', (req, res) => {
  const avisos = [];
  avisos.sort((a, b) => (b.cuando || '').localeCompare(a.cuando || ''));
  res.json({ avisos });
});

// ═══════════════════════════════════════════════════════════════
//  BORRAR DATOS
// ═══════════════════════════════════════════════════════════════
// Pedido por el dueño el 14 de agosto de 2026. Va contra todo lo demás que hay
// aquí —los apuntes no se editan ni se borran (DECISIONES.md #2), un día
// cerrado no se toca (#5)— y por eso está tan atado.
//
// El motivo de verdad es otro y es legítimo: se ha estado probando la
// aplicación con datos inventados y hay que empezar con los de verdad. Para eso
// hace falta poder vaciar, y hacerlo a mano en la base de datos del servidor es
// mucho peor que tener un botón que sabe qué se lleva por delante cada cosa.
//
// Las tres reglas de esta parte:
//   1. Solo el ADMINISTRADOR. No es un permiso que se pueda dar a un cargo.
//   2. Se hace una COPIA antes, siempre, y se dice cómo se llama.
//   3. Hay que escribir la palabra. Un «¿seguro?» se pulsa sin leer.
//
// Los grupos NO son las tablas: son las cosas como las entiende quien las
// borra. Y arrastran lo suyo: borrar las ventas sin borrar sus movimientos
// dejaría un inventario que no cuadra con ninguna venta, y borrar los productos
// dejando los movimientos dejaría apuntes de algo que ya no existe.
const GRUPOS_BORRADO = {
  ventas: {
    nombre: 'Ventas, mercancía y días',
    detalle: 'Las ventas, las entradas, las mermas, los traslados, los conteos y los días ' +
             'cerrados. El inventario queda en cero y hay que volver a contarlo.',
    // Los movimientos de una inversión se van con SU grupo.
    tablas: ['ventas', 'conteos', 'dias', 'traslados'],
    extra: db => ({
      movimientos: db.prepare(`DELETE FROM movimientos
        WHERE COALESCE(ref_tipo,'') <> 'inversion'`).run().changes,
      fondo: db.prepare("DELETE FROM fondo WHERE COALESCE(ref_tipo,'')='venta'").run().changes,
    }),
    cuenta: db => db.prepare('SELECT COUNT(*) n FROM ventas').get().n +
                  db.prepare("SELECT COUNT(*) n FROM movimientos WHERE COALESCE(ref_tipo,'') <> 'inversion'").get().n,
  },
  dinero: {
    nombre: 'El dinero del fondo',
    detalle: 'Los retiros, los gastos, los ingresos a mano y los traspasos entre sitios. ' +
             'Todas las gavetas quedan en cero.',
    tablas: [],
    extra: db => ({ fondo: db.prepare(
      "DELETE FROM fondo WHERE COALESCE(ref_tipo,'') <> 'inversion'").run().changes }),
    cuenta: db => db.prepare(
      "SELECT COUNT(*) n FROM fondo WHERE COALESCE(ref_tipo,'') <> 'inversion'").get().n,
  },
  inversiones: {
    nombre: 'Inversiones',
    detalle: 'Las compras de mercancía con su reparto, y el dinero que salió por ellas.',
    tablas: ['inversion_reparto', 'inversion_lineas', 'inversiones'],
    extra: db => ({
      movimientos: db.prepare("DELETE FROM movimientos WHERE COALESCE(ref_tipo,'')='inversion'").run().changes,
      fondo: db.prepare("DELETE FROM fondo WHERE COALESCE(ref_tipo,'')='inversion'").run().changes,
    }),
    cuenta: db => db.prepare('SELECT COUNT(*) n FROM inversiones').get().n,
  },
  catalogo: {
    nombre: 'El catálogo de productos',
    detalle: 'Los productos, sus fotos y los precios especiales de cada sitio. Hay que borrar ' +
             'también todo lo que los nombra.',
    tablas: ['precios_sitio', 'productos'],
    exige: ['ventas', 'inversiones'],
    cuenta: db => db.prepare('SELECT COUNT(*) n FROM productos').get().n,
  },
};

// Solo el administrador: es el unico con '*'. No es un permiso que se pueda
// dar a un cargo, a proposito.
const SOLO_ADMIN = 'Esto solo lo puede hacer el administrador.';
const soyAdmin = req => !!(req.permisos && req.permisos.includes('*'));

// Lo que hay ahora de cada cosa, para poder mirarlo ANTES de borrar nada. Sin
// esto se borra a ciegas, y «¿seguro?» no es una pregunta si uno no sabe
// cuánto se está llevando por delante.
app.get('/api/borrar/vista-previa', (req, res) => {
  if (!soyAdmin(req)) return res.status(403).json({ error: SOLO_ADMIN });
  res.json({
    grupos: Object.entries(GRUPOS_BORRADO).map(([id, g]) => ({
      id, nombre: g.nombre, detalle: g.detalle, exige: g.exige || [], cuantos: g.cuenta(db),
    })),
    hay_otras_copias: db.prepare('SELECT COUNT(*) n FROM sync_marcas').get().n > 0,
  });
});

app.post('/api/borrar', async (req, res) => {
  if (!soyAdmin(req)) return res.status(403).json({ error: SOLO_ADMIN });
  const b = req.body || {};
  // La palabra se comprueba AQUÍ y no solo en la pantalla: esconder un botón no
  // es seguridad, es decoración (DECISIONES.md #10).
  if (String(b.confirmacion || '').trim().toUpperCase() !== 'BORRAR')
    return res.status(400).json({ error: 'Hay que escribir BORRAR para confirmar' });
  const pedidos = Array.isArray(b.grupos) ? b.grupos.filter(g => GRUPOS_BORRADO[g]) : [];
  if (!pedidos.length) return res.status(400).json({ error: 'No has elegido nada que borrar' });

  // Las dependencias también se comprueban aquí: borrar los productos dejando
  // las ventas que los nombran deja apuntes de algo que ya no existe.
  for (const g of pedidos)
    for (const nec of (GRUPOS_BORRADO[g].exige || []))
      if (!pedidos.includes(nec)) return res.status(400).json({
        error: 'Para borrar «' + GRUPOS_BORRADO[g].nombre + '» hay que borrar también «' +
               GRUPOS_BORRADO[nec].nombre + '».' });

  // La copia va ANTES y fuera de la transacción: si falla, no se borra nada.
  let copia = null;
  try { copia = await salvar('antes de borrar'); }
  catch (e) { return res.status(500).json({
    error: 'No se pudo hacer la copia de seguridad, así que no se ha borrado nada: ' + e.message }); }

  const borrado = {};
  try {
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      for (const g of pedidos) {
        const def = GRUPOS_BORRADO[g];
        if (def.extra) Object.assign(borrado, sumar(borrado, def.extra(db)));
        for (const t of def.tablas)
          borrado[t] = (borrado[t] || 0) + db.prepare('DELETE FROM ' + t).run().changes;
      }
    })();
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo borrar: ' + e.message +
      '. La copia ' + copia + ' está a salvo.' });
  } finally { db.pragma('foreign_keys = ON'); }

  console.log('[borrado] ' + pedidos.join(', ') + ' · copia ' + copia + ' · ' +
              JSON.stringify(borrado));
  res.json({ ok: true, copia, borrado, grupos: pedidos });
});
const sumar = (a, b) => {
  const r = Object.assign({}, a);
  for (const [k, v] of Object.entries(b)) r[k] = (r[k] || 0) + v;
  return r;
};

// ─── De dónde salió un apunte del fondo ───────────────────────
// Pedido por el dueño el 14 de agosto de 2026: tocar un movimiento y que lleve
// a la operación que lo creó.
//
// Cada apunte guarda de qué viene (ref_tipo y ref_id) desde el primer día, pero
// eso no se enseñaba en ningún sitio: en la lista salía «Venta · 1 500 CUP» y
// para saber qué venta era había que ir a Cierre, poner la fecha buena, elegir
// el sitio bueno y buscarla a ojo entre las del día.
//
// Se contesta con lo que hace falta para ENTENDER el apunte sin salir de la
// pantalla, y con lo justo para poder abrir la operación entera si se quiere.
app.get('/api/fondo/:id', exige('ver_fondo'), (req, res) => {
  const a = db.prepare(`SELECT f.*, s.nombre sitio, p.nombre persona FROM fondo f
      LEFT JOIN sitios s ON s.id=f.sitio_id LEFT JOIN personas p ON p.id=f.persona_id
      WHERE f.id=?`).get(String(req.params.id));
  if (!a) return res.status(404).json({ error: 'Ese apunte no está en esta copia' });
  // Si este apunte se puede corregir, y si ya está anulado. Lo decide el
  // servidor y no la pantalla: esconder un botón es decoración (#10). Los
  // botones se pintan con esto, y la comprobación de verdad se vuelve a hacer
  // al pulsarlos.
  // Ojo: aquí se preguntaba por 'gestionar_dinero', que dejó de existir al partir
  // los permisos (#35) y desde entonces no lo tenía NADIE. El botón de corregir
  // solo salía porque el administrador pasa por delante de todos los permisos. El
  // permiso que corresponde es el que guarda la puerta de corregir.
  const r = { apunte: a, origen: null,
    se_puede_tocar: !apunteQueSePuedeTocar(a.id).error && puede(req, 'corregir_dinero'),
    anulado: !!db.prepare('SELECT 1 FROM fondo WHERE anula_a=?').get(a.id) };

  if (a.ref_tipo === 'venta' && a.ref_id) {
    const v = db.prepare(`SELECT v.*, s.nombre sitio, p.nombre persona FROM ventas v
        LEFT JOIN sitios s ON s.id=v.sitio_id LEFT JOIN personas p ON p.id=v.persona_id
        WHERE v.id=?`).get(a.ref_id);
    if (v) r.origen = { tipo: 'venta', venta: v,
      lineas: db.prepare(`SELECT m.cantidad, m.precio_unit, pr.nombre, pr.um
          FROM movimientos m LEFT JOIN productos pr ON pr.id=m.producto_id
          WHERE m.ref_tipo='venta' AND m.ref_id=? AND m.anula_a IS NULL`).all(a.ref_id) };

  } else if (a.ref_tipo === 'inversion' && a.ref_id) {
    const i = db.prepare('SELECT id,numero,nombre,proveedor,estado,moneda,fecha FROM inversiones WHERE id=?')
      .get(a.ref_id);
    if (i) r.origen = { tipo: 'inversion', inversion: i };

  } else if (a.ref_tipo === 'traspaso' && a.ref_id) {
    // Las dos mitades, para que se vea de dónde salió y a dónde fue sin tener
    // que buscar la otra en la lista.
    r.origen = { tipo: 'traspaso', mitades: db.prepare(`SELECT f.tipo, f.importe, f.moneda,
        f.concepto, s.nombre sitio FROM fondo f LEFT JOIN sitios s ON s.id=f.sitio_id
        WHERE f.ref_tipo='traspaso' AND f.ref_id=? ORDER BY f.tipo`).all(a.ref_id) };
  }
  res.json(r);
});

// Una venta suelta, con lo que llevaba. Hacía falta para poder mirar la venta
// que hay detrás de un apunte del fondo sin tener que cargar el día entero del
// sitio en el que se hizo.
app.get('/api/ventas/:id', exige('ver_ventas'), (req, res) => {
  const v = db.prepare(`SELECT v.*, s.nombre sitio, p.nombre persona FROM ventas v
      LEFT JOIN sitios s ON s.id=v.sitio_id LEFT JOIN personas p ON p.id=v.persona_id
      WHERE v.id=?`).get(String(req.params.id));
  if (!v) return res.status(404).json({ error: 'Esa venta no está en esta copia' });
  if (!puede(req, 'ver_ganancias')) { v.costo_total = null; v.comision = null; }
  res.json({ venta: v, lineas: db.prepare(`SELECT m.cantidad, m.precio_unit, pr.nombre, pr.um
      FROM movimientos m LEFT JOIN productos pr ON pr.id=m.producto_id
      WHERE m.ref_tipo='venta' AND m.ref_id=? AND m.anula_a IS NULL`).all(v.id) });
});

// ─── Pasar dinero de una gaveta a otra ────────────────────────
// Pedido por el dueño el 14 de agosto de 2026: «necesito poder pasar dinero de
// una tienda a otra». Antes solo se podía sacar del negocio (un retiro) y eso
// no es lo mismo: el dinero no sale, cambia de sitio.
//
// Se apunta como DOS mitades —un retiro donde estaba y un ingreso donde va—
// enlazadas por el mismo ref_id, igual que un traslado de mercancía. Así:
//   · los apuntes siguen siendo inmutables (DECISIONES.md #2);
//   · el fondo general no se mueve, porque las dos mitades se compensan;
//   · y cada gaveta cuadra con el dinero que hay dentro de verdad.
//
// Las dos mitades van en la MISMA moneda a propósito. Cambiar pesos por
// dólares no es pasar dinero de sitio: es una compraventa, con su cambio y su
// ganancia o pérdida, y meterla aquí escondería esa cuenta dentro de un
// traspaso. Si algún día hace falta, será su propia pantalla.
app.post('/api/fondo/traspaso', exige('traspasos'), (req, res) => {
  const b = req.body || {};
  const origen = String(b.origen_id || '');
  const destino = String(b.destino_id || '');
  const moneda = b.moneda === 'USD' ? 'USD' : 'CUP';
  const importe = Number(b.importe);
  if (!origen || !destino) return res.status(400).json({ error: 'Falta de dónde sale o a dónde va' });
  if (origen === destino) return res.status(400).json({ error: 'El origen y el destino son el mismo sitio' });
  if (!(importe > 0)) return res.status(400).json({ error: 'El importe tiene que ser mayor que cero' });
  const nombre = id => {
    const s = db.prepare('SELECT nombre FROM sitios WHERE id=? AND activo=1').get(id);
    return s ? s.nombre : null;
  };
  const nOrigen = nombre(origen), nDestino = nombre(destino);
  if (!nOrigen || !nDestino) return res.status(400).json({ error: 'Alguno de los dos sitios no existe' });

  // Sacar más de lo que hay deja la gaveta en negativo, y una gaveta en
  // negativo no existe: significa que falta un apunte o que alguien se
  // equivocó de sitio. Se avisa con la cifra, para poder corregir el importe
  // en vez de tener que ir a buscarla. Es el mismo guardián de todo lo que sale
  // (#38), escrito una sola vez.
  const sinFondo = faltaDinero(origen, moneda, importe,
    'Pasa lo que haya, o apunta primero en ' + nOrigen + ' el dinero que entró.');
  if (sinFondo) return res.status(400).json({ error: sinFondo });

  const ref = nuevoId();
  const fecha = b.fecha || ahoraISO().slice(0, 10);
  const ts = Date.now();
  const concepto = String(b.concepto || '').trim().slice(0, 200);
  db.transaction(() => {
    apuntarFondo({ tipo: 'retiro', subtipo: 'traspaso', moneda, importe, sitio_id: origen,
      concepto: 'A ' + nDestino + (concepto ? ' · ' + concepto : ''),
      ref_tipo: 'traspaso', ref_id: ref, fecha, ts });
    apuntarFondo({ tipo: 'ingreso', subtipo: 'traspaso', moneda, importe, sitio_id: destino,
      concepto: 'De ' + nOrigen + (concepto ? ' · ' + concepto : ''),
      ref_tipo: 'traspaso', ref_id: ref, fecha, ts });
  })();
  res.json({ ok: true, ref, origen: saldoFondo(origen), destino: saldoFondo(destino) });
});

// ═══════════════════════════════════════════════════════════════
//  INVERSIONES: qué se compró, dónde se puso y cuánto se ha recuperado
// ═══════════════════════════════════════════════════════════════
// Una inversión es una compra de mercancía con nombre: la lista de lo que se
// compró, a qué precio cada cosa y a qué sitio va cada unidad. El importe no se
// escribe, se suma de las líneas.
//
// Nada de la recuperación se guarda: se calcula de las ventas de esos mismos
// productos, igual que el stock se calcula de los movimientos (DECISIONES.md
// #1). Así no hay dos verdades que puedan contradecirse.

// Un número correlativo y legible, del estilo INV-0001. Lo genera el servidor,
// como el código de los productos, para que dos aparatos sin internet no
// puedan crear dos con el mismo (DECISIONES.md #3).
function siguienteNumero(prefijo, tabla) {
  const f = db.prepare(`SELECT numero FROM ${tabla} WHERE numero LIKE ?
      ORDER BY CAST(SUBSTR(numero, ?) AS INTEGER) DESC LIMIT 1`)
    .get(prefijo + '-%', prefijo.length + 2);
  const n = f && f.numero ? parseInt(f.numero.slice(prefijo.length + 1), 10) + 1 : 1;
  return prefijo + '-' + String(n).padStart(4, '0');
}

function lineasInversion(id) {
  const lineas = db.prepare(`SELECT l.*, p.nombre nombre_producto, p.codigo, p.um
      FROM inversion_lineas l LEFT JOIN productos p ON p.id = l.producto_id
      WHERE l.inversion_id = ? ORDER BY l.orden, l.id`).all(id);
  const rep = db.prepare(`SELECT r.*, s.nombre sitio FROM inversion_reparto r
      LEFT JOIN sitios s ON s.id = r.sitio_id WHERE r.inversion_id = ?`).all(id);
  lineas.forEach(l => {
    l.reparto = rep.filter(r => r.linea_id === l.id);
    l.importe = redondear(l.cantidad * l.costo_unit, monedaBase());
    // Una línea sin producto es dinero con un concepto: no es mercancía, no
    // entra en el inventario y no se reparte entre sitios.
    l.es_dinero = !l.producto_id;
    l.nombre = l.nombre_producto || l.descripcion || 'Sin concepto';
  });
  return lineas;
}
const lineasConProducto = lineas => lineas.filter(l => l.producto_id);
const importeInversion = lineas =>
  lineas.reduce((s, l) => s + Number(l.cantidad || 0) * Number(l.costo_unit || 0), 0);
// Un movimiento sigue en pie si no anula a nadie Y nadie lo ha anulado a él.
// Mirar solo 'anula_a IS NULL' es el error fácil: el movimiento ANULADO también
// lo tiene vacío —quien lleva la marca es el contrario—, así que con esa
// condición sola, deshacer algo dos veces lo deshacía por partida doble.
const EN_PIE = "anula_a IS NULL AND NOT EXISTS " +
  "(SELECT 1 FROM movimientos x WHERE x.anula_a = movimientos.id)";
const enPie = alias => `${alias}.anula_a IS NULL AND NOT EXISTS ` +
  `(SELECT 1 FROM movimientos x WHERE x.anula_a = ${alias}.id)`;

// El reparto de las ventas entre las inversiones. Cada unidad vendida se le
// apunta a la compra más vieja que todavía tenga unidades sin vender: la
// primera mercancía que entró es la primera que sale.
//
// Cuentan las dos formas de que un producto salga y se cobre: la venta directa
// en la caja y la mercancía que se lleva una inversión cancelada, que para
// esto es una venta más. Lo que no cuenta es la merma: eso es pérdida, no
// dinero recuperado, y por eso gasta unidades pero no aporta nada.
function repartoDeInversiones() {
  // OJO con el costo: el del MOVIMIENTO va en CUP, como todo el inventario. El
  // que hace falta aquí es el de la inversión, en SU moneda, porque contra él
  // se mide el porcentaje recuperado. Se saca de la línea. Por eso el mismo
  // producto no puede estar dos veces en una inversión: no se sabría cuál de
  // los dos costos es el de estas unidades.
  const compras = db.prepare(`SELECT m.id, m.producto_id, m.cantidad, m.ts, m.fecha,
        m.sitio_id, m.costo_unit costo_cup, m.ref_id inversion_id, i.moneda moneda_inv,
        COALESCE((SELECT l.costo_unit FROM inversion_lineas l
                  WHERE l.inversion_id = m.ref_id AND l.producto_id = m.producto_id
                  ORDER BY l.orden LIMIT 1), 0) costo_unit
      FROM movimientos m JOIN inversiones i ON i.id = m.ref_id
      WHERE m.tipo='compra' AND ${enPie('m')} AND m.ref_tipo='inversion'
        AND i.estado='registrada'
      ORDER BY m.ts, m.id`).all()
    .map(c => Object.assign(c, { restante: Math.abs(c.cantidad) }));
  if (!compras.length) return { trozos: [], compras: [] };

  const productos = [...new Set(compras.map(c => c.producto_id))];
  const salidas = db.prepare(`SELECT m.id, m.tipo, m.producto_id, m.cantidad, m.precio_unit,
        m.ts, m.fecha, m.ref_tipo, m.ref_id,
        v.moneda moneda_venta, v.cliente
      FROM movimientos m
      LEFT JOIN ventas v ON v.id = m.ref_id AND m.tipo='venta'
      WHERE m.tipo IN ('venta','merma') AND ${enPie('m')}
        AND (m.tipo <> 'venta' OR v.anulada_en IS NULL)
        AND m.producto_id IN (${huecos(productos.length)})
      ORDER BY m.ts, m.id`).all(...productos);

  const trozos = [];
  for (const s of salidas) {
    let quedan = Math.abs(Number(s.cantidad) || 0);
    for (const c of compras) {
      if (quedan <= 0) break;
      if (c.producto_id !== s.producto_id || c.restante <= 0 || c.ts > s.ts) continue;
      const usa = Math.min(c.restante, quedan);
      c.restante -= usa; quedan -= usa;
      // La merma gasta unidades pero no trae un peso. Se apunta igual, porque
      // «de 100 quedan 60» sin decir que 10 se rompieron es un descuadre que
      // nadie sabría explicar.
      if (s.tipo === 'merma') {
        trozos.push({ inversion_id: c.inversion_id, producto_id: s.producto_id,
          unidades: usa, importe: 0, moneda: monedaBase(), costo: usa * Number(c.costo_unit || 0),
          fecha: s.fecha, cobrado: false, de: 'merma', ref_id: s.id, texto: 'Merma' });
        continue;
      }
      trozos.push({
        inversion_id: c.inversion_id, moneda_inv: c.moneda_inv, compra_id: c.id,
        producto_id: s.producto_id, unidades: usa,
        importe: usa * Number(s.precio_unit || 0),
        moneda: s.moneda_venta === 'USD' ? 'USD' : 'CUP',
        costo: usa * Number(c.costo_unit || 0),   // en la moneda de la inversión
        fecha: s.fecha,
        ref_id: s.ref_id,
        cobrado: true, de: 'venta',
        texto: 'Venta' + (s.cliente ? ' — ' + s.cliente : '')
      });
    }
  }
  return { trozos, compras };
}

// Las cuentas de UNA inversión, todas en su moneda: es la única forma de decir
// «se ha recuperado el 60% del costo» sin que el número signifique dos cosas.
// Lo que entró en la otra moneda se pasa con el valor del dólar de hoy, y se
// avisa de que por eso es aproximado.
function cuentasInversion(inv) {
  const lineas = lineasInversion(inv.id);
  const importe = importeInversion(lineas);
  // Solo cuentan como unidades las de MERCANCÍA. Una línea de dinero lleva
  // cantidad 1 para poder multiplicar por su importe, pero «1 transporte» no es
  // una unidad de nada y sumarla haría que el porcentaje vendido no signifique.
  const unidades = lineasConProducto(lineas).reduce((s, l) => s + Number(l.cantidad || 0), 0);
  const { trozos, compras } = repartoDeInversiones();
  const mios = trozos.filter(t => t.inversion_id === inv.id);

  const entrado = { CUP: 0, USD: 0 };      // lo crudo, sin convertir nada
  let costoRec = 0, extra = 0, pendiente = 0, udsVendidas = 0, udsPendientes = 0;
  let udsPerdidas = 0, perdido = 0, sinTasa = false;
  const eventos = [];
  for (const t of mios) {
    if (t.de === 'merma') { udsPerdidas += t.unidades; perdido += t.costo; continue; }
    udsVendidas += t.unidades;
    const ing = convertir(t.importe, t.moneda, inv.moneda);
    if (ing === null) { sinTasa = true; continue; }
    if (!t.cobrado) { pendiente += ing; udsPendientes += t.unidades; continue; }
    entrado[t.moneda] += t.importe;
    // El dinero que entra repone primero lo que costó; lo que sobra es ganancia.
    // Si se vendió por debajo del costo, no hay ganancia y se recupera menos.
    const repone = Math.min(ing, t.costo), gana = Math.max(0, ing - t.costo);
    costoRec += repone;
    extra += gana;
    // Cada apunte guarda las dos partes por separado. Si el mes a mes sumara
    // solo lo que entró, su porcentaje no cuadraría con el de arriba —que es
    // del COSTO— y las dos cifras se contradirían en la misma pantalla.
    eventos.push({ fecha: t.fecha, importe: ing, costo: repone, ganancia: gana,
                   de: t.de, texto: t.texto, unidades: t.unidades, ref_id: t.ref_id });
  }

  const dineroSuelto = lineas.filter(l => !l.producto_id)
    .reduce((s, l) => s + Number(l.cantidad || 0) * Number(l.costo_unit || 0), 0);
  const red = n => redondear(n, inv.moneda);
  const pct = importe > 0 ? Math.round(costoRec / importe * 1000) / 10 : null;
  return {
    lineas, importe: red(importe), unidades,
    unidades_vendidas: udsVendidas, unidades_perdidas: udsPerdidas, perdido: red(perdido),
    unidades_quedan: Math.max(0, unidades - udsVendidas - udsPerdidas),
    entrado, costo_recuperado: red(costoRec), extra: red(extra),
    pendiente: red(pendiente), unidades_pendientes: udsPendientes,
    pct_costo: pct, sin_tasa: sinTasa, tasa: tasaUSD(),
    dinero_suelto: red(dineroSuelto),
    eventos, compras: compras.filter(c => c.inversion_id === inv.id)
  };
}

// Mes a mes y a qué ritmo va, igual que en el fondo: la línea de tiempo es lo
// que contesta «¿en cuánto tiempo recupero esto?», que es la pregunta de verdad.
function recuperacionInversion(inv) {
  const c = cuentasInversion(inv);
  const meses = new Map();
  for (const e of c.eventos) {
    const k = String(e.fecha || '').slice(0, 7);
    if (!k) continue;
    const m = meses.get(k) || { mes: k, importe: 0, costo: 0, ganancia: 0 };
    m.importe += e.importe;
    m.costo += (e.costo || 0);
    m.ganancia += (e.ganancia || 0);
    meses.set(k, m);
  }
  const linea = [...meses.values()].sort((a, b) => a.mes < b.mes ? -1 : 1);
  // Lo que se acumula es el COSTO recuperado, para que el porcentaje de aquí
  // sea el mismo que el de arriba. La ganancia va en su columna, aparte.
  let acum = 0, recuperadaEl = null;
  for (const m of linea) {
    acum += m.costo;
    m.importe = redondear(m.importe, inv.moneda);
    m.costo = redondear(m.costo, inv.moneda);
    m.ganancia = redondear(m.ganancia, inv.moneda);
    m.acumulado = redondear(acum, inv.moneda);
    m.pct = c.importe > 0 ? Math.round(Math.min(acum, c.importe) / c.importe * 1000) / 10 : null;
    if (!recuperadaEl && c.importe > 0 && acum >= c.importe) recuperadaEl = m.mes;
  }

  // El ritmo se mide desde que empezó a entrar dinero, no desde la compra:
  // entre comprar y empezar a vender puede pasar un mes, y contarlo hundiría
  // el ritmo y daría una fecha que no se parece a nada.
  const fechas = c.eventos.map(e => e.fecha).filter(Boolean).sort();
  const hoy = ahoraISO().slice(0, 10);
  let ritmo = null;
  if (fechas.length && c.costo_recuperado > 0 && c.importe > 0) {
    const dias = Math.max(1, Math.round((Date.parse(hoy) - Date.parse(fechas[0])) / 86400000) + 1);
    const porDia = c.costo_recuperado / dias;
    const falta = Math.max(0, c.importe - c.costo_recuperado);
    const faltanDias = porDia > 0 ? Math.ceil(falta / porDia) : null;
    ritmo = { dias, por_dia: redondear(porDia, inv.moneda), falta: redondear(falta, inv.moneda),
      faltan_dias: faltanDias,
      fecha_estimada: (!faltanDias || falta <= 0) ? null
        : new Date(Date.parse(hoy) + faltanDias * 86400000).toISOString().slice(0, 10) };
  }
  return Object.assign(c, { linea, recuperada_el: recuperadaEl, ritmo });
}

// Ver la LISTA de inversiones y ver su DINERO son dos cosas distintas: al
// encargado le puede tocar saber qué compras hay en marcha sin ver a qué precio se
// compró. Está en una función porque la usan la lista y la ficha, y cuando ese
// criterio vivía escrito dos veces una de las dos se quedó sin taparlo (#10).
const verDineroInversiones = req => puede(req, 'ver_ganancias', 'gestionar_inversiones');

app.get('/api/inversiones', exige('ver_inversiones'), (req, res) => {
  const todas = req.query.todas === '1';
  const filas = db.prepare(`SELECT * FROM inversiones
      ${todas ? '' : "WHERE estado <> 'cancelada'"} ORDER BY fecha DESC, creado_en DESC`).all();
  if (!verDineroInversiones(req))
    return res.json({ inversiones: filas.map(i => ({ id: i.id, numero: i.numero,
      nombre: i.nombre, estado: i.estado, fecha: i.fecha })), cifras: false });
  filas.forEach(i => {
    const c = cuentasInversion(i);
    Object.assign(i, { importe: c.importe, unidades: c.unidades,
      unidades_vendidas: c.unidades_vendidas, costo_recuperado: c.costo_recuperado,
      extra: c.extra, pendiente: c.pendiente, pct_costo: c.pct_costo, sin_tasa: c.sin_tasa });
  });
  res.json({ inversiones: filas, cifras: true, tasa_usd: tasaUSD() });
});

app.get('/api/inversiones/:id', exige('ver_inversiones'), (req, res) => {
  const inv = db.prepare('SELECT * FROM inversiones WHERE id=?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Esa inversión no existe' });
  // Quien puede ver QUÉ compras hay pero no el dinero, recibe la ficha sin una
  // sola cifra. Antes esta puerta la guardaba el propio permiso de entrada
  // ('gestionar_dinero'); al partir los permisos, entrar aquí pasó a ser posible
  // para más gente y las cifras se habrían ido con ellos (DECISIONES.md #10).
  if (!verDineroInversiones(req)) return res.json({
    inversion: { id: inv.id, numero: inv.numero, nombre: inv.nombre,
                 estado: inv.estado, fecha: inv.fecha, moneda: inv.moneda },
    cifras: false, lineas: [], eventos: [], meses: [] });
  res.json(Object.assign({ inversion: inv, cifras: true }, recuperacionInversion(inv)));
});

// Crear o cambiar un borrador. Una vez registrada no se toca: las líneas
// documentan lo que se compró y a qué costo (DECISIONES.md #2).
app.post('/api/inversiones', exige('gestionar_inversiones'), (req, res) => {
  const b = req.body || {};
  const nombre = String(b.nombre || '').trim();
  if (nombre.length < 2) return res.status(400).json({ error: 'Ponle nombre a la inversión' });
  const ahora = ahoraISO();
  let id = b.id || null;
  if (id) {
    const y = db.prepare('SELECT estado FROM inversiones WHERE id=?').get(id);
    if (!y) return res.status(404).json({ error: 'Esa inversión no existe' });
    if (y.estado !== 'borrador') return res.status(409).json({
      error: 'Esa inversión ya está registrada y no se puede cambiar. Para corregirla, ' +
             'cancélala y haz otra: así queda constancia de lo que pasó.' });
  }
  try {
    db.transaction(() => {
      // Y SIEMPRE sale de una caja de verdad. Hasta el 21 de agosto de 2026 se
      // podía dejar en blanco y el dinero salía «del fondo del negocio», que no
      // es ninguna gaveta que se pueda ir a contar: el dueño pidió quitar esa
      // opción y dejar solo los puntos que existen (DECISIONES.md #38).
      const sitioId = b.sitio_id || null;
      if (!sitioId) throw new Error(
        'Di de qué caja sale el dinero: la tienda, el almacén o la brigada. ' +
        'Sin eso, esa gaveta seguiría diciendo que tiene un dinero que ya no está.');
      if (!db.prepare('SELECT 1 FROM sitios WHERE id=?').get(sitioId))
        throw new Error('Ese sitio no está en esta copia');
      if (!id) {
        id = nuevoId();
        db.prepare(`INSERT INTO inversiones (id,numero,nombre,proveedor,nota,moneda,sitio_id,estado,fecha,creado_en,actualizado)
            VALUES (?,?,?,?,?,?,?,'borrador',?,?,?)`)
          .run(id, siguienteNumero('INV', 'inversiones'), nombre, b.proveedor || null,
               b.nota || null, b.moneda === 'USD' ? 'USD' : 'CUP', sitioId,
               b.fecha || ahora.slice(0, 10), ahora, ahora);
      } else {
        db.prepare(`UPDATE inversiones SET nombre=?, proveedor=?, nota=?, moneda=?,
            sitio_id=?, fecha=?, actualizado=? WHERE id=?`)
          .run(nombre, b.proveedor || null, b.nota || null,
               b.moneda === 'USD' ? 'USD' : 'CUP', sitioId,
               b.fecha || ahora.slice(0, 10), ahora, id);
      }
      db.prepare('DELETE FROM inversion_reparto WHERE inversion_id=?').run(id);
      db.prepare('DELETE FROM inversion_lineas WHERE inversion_id=?').run(id);
      const insL = db.prepare(`INSERT INTO inversion_lineas
          (id,inversion_id,producto_id,descripcion,cantidad,costo_unit,orden)
          VALUES (?,?,?,?,?,?,?)`);
      const insR = db.prepare(`INSERT INTO inversion_reparto
          (linea_id,inversion_id,sitio_id,cantidad) VALUES (?,?,?,?)`);
      const vistos = new Set();
      (b.lineas || []).forEach((l, i) => {
        const cant = Number(l.cantidad) || 0;
        if (cant <= 0) return;
        // Línea de DINERO: no lleva producto, lleva concepto. No entra en el
        // inventario ni se reparte entre sitios, pero sale del fondo igual.
        if (!l.producto_id) {
          const concepto = String(l.descripcion || '').trim();
          if (concepto.length < 2) throw new Error(
            'Hay una línea sin producto y sin concepto. Escribe en qué se fue ese dinero: ' +
            'dentro de un mes, «50» a secas no lo explica nadie.');
          insL.run(nuevoId(), id, null, concepto.slice(0, 120), cant,
                   Number(l.costo_unit) || 0, i);
          return;
        }
        const p = db.prepare('SELECT id, nombre FROM productos WHERE id=? AND borrado_en IS NULL').get(l.producto_id);
        if (!p) throw new Error('Un producto de la lista ya no existe');
        // El mismo producto dos veces en la misma inversión no se admite: al
        // vender una unidad no se sabría a cuál de los dos costos apuntarla, y
        // el porcentaje recuperado saldría distinto según cómo se mire.
        if (vistos.has(l.producto_id))
          throw new Error('«' + p.nombre + '» está dos veces en la lista. Ponlo una sola vez, ' +
                          'con la cantidad total, y repártelo entre los sitios.');
        vistos.add(l.producto_id);
        const lid = nuevoId();
        insL.run(lid, id, l.producto_id, null, cant, Number(l.costo_unit) || 0, i);
        let repartido = 0;
        for (const r of (l.reparto || [])) {
          const c = Number(r.cantidad) || 0;
          if (!r.sitio_id || c <= 0) continue;
          if (repartido + c > cant + 0.0001)
            throw new Error('En «' + (l.nombre || 'un producto') + '» estás repartiendo más ' +
                            'unidades de las que compraste');
          insR.run(lid, id, r.sitio_id, c);
          repartido += c;
        }
      });
    })();
  } catch (e) { return res.status(400).json({ error: e.message }); }
  const inv = db.prepare('SELECT * FROM inversiones WHERE id=?').get(id);
  res.json({ ok: true, id, inversion: inv, lineas: lineasInversion(id) });
});

// Registrarla: la mercancía entra en cada sitio y el dinero sale del fondo.
// Es el momento en que deja de ser un papel y pasa a ser inventario.
app.post('/api/inversiones/:id/registrar', exige('gestionar_inversiones'), (req, res) => {
  const inv = db.prepare('SELECT * FROM inversiones WHERE id=?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Esa inversión no existe' });
  if (inv.estado !== 'borrador')
    return res.status(409).json({ error: 'Esa inversión ya estaba registrada' });
  const lineas = lineasInversion(inv.id);
  if (!lineas.length) return res.status(400).json({
    error: 'La inversión está vacía: ponle al menos un producto o una línea de dinero.' });
  // Solo la mercancía entra en el inventario. Lo demás —transporte, un
  // ayudante, la comida de la obra— sale del fondo y no tiene dónde guardarse.
  const conProducto = lineasConProducto(lineas);

  // El costo de los movimientos va en la MONEDA DEL NEGOCIO, como todo el
  // inventario. Si la inversión está en otra hace falta el valor del dólar, y
  // se congela el de hoy: dentro de un año esa compra costó lo que costó.
  const base = monedaBase();
  const aLaBase = v => convertir(v, inv.moneda, base);
  if (aLaBase(1) === null) return res.status(400).json({
    error: 'Esta inversión está en ' + inv.moneda + ' y el negocio se mide en ' + base +
           '. Falta poner el valor del dólar en Ajustes para saber a cuánto entra la mercancía.' });

  // De qué caja sale, y que en esa caja ESTÉ el dinero (DECISIONES.md #38). Se
  // comprueba aquí y no al guardar el borrador a propósito: un borrador es un
  // papel, se puede preparar la compra antes de tener el dinero. Lo que no puede
  // es registrarse, porque registrar es el momento en que el dinero sale.
  //
  // Un borrador guardado antes del 21 de agosto de 2026 puede no llevar caja: se
  // pide abrirlo y elegirla —es un toque— en vez de sacarle el dinero a un sitio
  // que nadie eligió.
  const importeTotal = redondear(importeInversion(lineas), inv.moneda);
  if (!inv.sitio_id) return res.status(400).json({
    error: 'Esta inversión no dice de qué caja sale el dinero. Ábrela, elige el sitio ' +
           'en «¿De qué caja sale el dinero?» y vuelve a registrarla.' });
  const sinFondo = faltaDinero(inv.sitio_id, inv.moneda, importeTotal);
  if (sinFondo) return res.status(400).json({ error: sinFondo });

  const principal = db.prepare(`SELECT id FROM sitios WHERE tipo='almacen' AND activo=1
      ORDER BY creado_en LIMIT 1`).get();
  const fecha = inv.fecha, ahora = ahoraISO(), ts = Date.now();

  // Un día cerrado no se toca (DECISIONES.md #5). Se comprueban TODOS los
  // sitios antes de escribir nada: quedarse a medias sería peor.
  const destinos = new Set();
  for (const l of conProducto) {
    let repartido = 0;
    for (const r of l.reparto) { destinos.add(r.sitio_id); repartido += r.cantidad; }
    if (repartido < l.cantidad - 0.0001) destinos.add((principal || {}).id);
  }
  for (const s of destinos) {
    if (!s) return res.status(400).json({ error: 'No hay ningún almacén donde meter lo que no repartiste' });
    if (diaCerrado(s, fecha)) return res.status(409).json({
      error: 'El día ' + fecha + ' ya está cerrado en ' +
        (db.prepare('SELECT nombre FROM sitios WHERE id=?').get(s) || {}).nombre +
        '. Reábrelo o pon otra fecha en la inversión.' });
  }

  try {
    db.transaction(() => {
      const ins = db.prepare(`INSERT INTO movimientos
          (id,tipo,sitio_id,persona_id,producto_id,cantidad,costo_unit,ref_tipo,ref_id,obs,fecha,ts,creado_en)
          VALUES (?,'compra',?,?,?,?,?,'inversion',?,?,?,?,?)`);
      for (const l of conProducto) {
        const costoBase = redondear(aLaBase(l.costo_unit), base);
        let repartido = 0;
        for (const r of l.reparto) {
          ins.run(nuevoId(), r.sitio_id, req.persona.id, l.producto_id, r.cantidad,
                  costoBase, inv.id, inv.nombre, fecha, ts, ahora);
          repartido += r.cantidad;
        }
        const resto = l.cantidad - repartido;
        if (resto > 0.0001)
          ins.run(nuevoId(), principal.id, req.persona.id, l.producto_id, resto,
                  costoBase, inv.id, inv.nombre, fecha, ts, ahora);
        // El costo del producto se pone al día con esta compra, si se pidió.
        // El costo viejo no se pierde: cada movimiento guarda el suyo.
        if (req.body && req.body.actualizar_costos && costoBase > 0)
          db.prepare('UPDATE productos SET costo=?, actualizado=? WHERE id=?')
            .run(costoBase, ahora, l.producto_id);
      }
      // Sale el importe ENTERO, mercancía y dinero suelto: del fondo salió todo.
      apuntarFondo({
        tipo: 'inversion',
        subtipo: conProducto.length ? 'Compra de productos' : 'Dinero para un trabajo',
        moneda: inv.moneda,
        importe: importeTotal,
        // De qué gaveta sale. Siempre una de verdad, comprobada arriba (#38).
        sitio_id: inv.sitio_id,
        concepto: (inv.numero ? inv.numero + ' · ' : '') + inv.nombre,
        ref_tipo: 'inversion', ref_id: inv.id, fecha, ts
      });
      db.prepare(`UPDATE inversiones SET estado='registrada', registrada_en=?, actualizado=?
                  WHERE id=?`).run(ahora, ahora, inv.id);
    })();
  } catch (e) { return res.status(400).json({ error: e.message }); }
  const nueva = db.prepare('SELECT * FROM inversiones WHERE id=?').get(inv.id);
  res.json(Object.assign({ ok: true, inversion: nueva }, recuperacionInversion(nueva)));
});

// Cancelarla: no se borra nada. Entra el movimiento contrario de cada entrada y
// el apunte contrario en el fondo, y queda a la vista lo que pasó.
app.post('/api/inversiones/:id/cancelar', exige('gestionar_inversiones'), (req, res) => {
  const inv = db.prepare('SELECT * FROM inversiones WHERE id=?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Esa inversión no existe' });
  if (inv.estado === 'cancelada') return res.json({ ok: true, inversion: inv });
  const ahora = ahoraISO(), ts = Date.now();
  try {
    db.transaction(() => {
      if (inv.estado === 'registrada') {
        const movs = db.prepare(`SELECT * FROM movimientos
            WHERE tipo='compra' AND ref_tipo='inversion' AND ref_id=? AND ${EN_PIE}`).all(inv.id);
        const ins = db.prepare(`INSERT INTO movimientos
            (id,tipo,sitio_id,persona_id,producto_id,cantidad,costo_unit,ref_tipo,ref_id,
             anula_a,motivo,fecha,ts,creado_en)
            VALUES (?,'compra',?,?,?,?,?,'inversion',?,?,?,?,?,?)`);
        // Cancelar saca del estante la mercancía que entró con la compra. Si ya
        // salió —se vendió, se usó en un trabajo o se dio de baja—, no está para
        // sacarla otra vez, y hacerlo dejaría el inventario en negativo (#40).
        const falta = faltaMercancia(movs.map(m => ({ sitio_id: m.sitio_id,
          producto_id: m.producto_id, cantidad: m.cantidad })),
          'De esa compra ya salió mercancía, así que la inversión no se puede deshacer entera. ' +
          'Lo que sí se puede es apuntar la merma o la devolución de lo que quede.');
        if (falta) throw new Error(falta);
        for (const m of movs)
          ins.run(nuevoId(), m.sitio_id, req.persona.id, m.producto_id, -m.cantidad,
                  m.costo_unit, inv.id, m.id, 'Inversión cancelada',
                  ahoraISO().slice(0, 10), ts, ahora);
        // El dinero vuelve a la MISMA gaveta de la que salió, no al montón: si
        // salió de la Tienda y volviera al negocio, la gaveta de la Tienda se
        // quedaría corta para siempre.
        for (const g of db.prepare(`SELECT COALESCE(sitio_id,'') sitio, subtipo, moneda,
              COALESCE(SUM(importe),0) v FROM fondo
            WHERE tipo='inversion' AND ref_tipo='inversion' AND ref_id=?
            GROUP BY COALESCE(sitio_id,''), subtipo, moneda`).all(inv.id))
          if (g.v) apuntarFondo({ tipo: 'inversion', subtipo: g.subtipo, moneda: g.moneda,
            importe: -g.v, sitio_id: g.sitio || null, concepto: 'Cancelada: ' + inv.nombre,
            ref_tipo: 'inversion', ref_id: inv.id, ts });
      }
      db.prepare(`UPDATE inversiones SET estado='cancelada', cancelada_en=?, actualizado=?
                  WHERE id=?`).run(ahora, ahora, inv.id);
    })();
  } catch (e) { return res.status(400).json({ error: e.message }); }
  res.json({ ok: true, inversion: db.prepare('SELECT * FROM inversiones WHERE id=?').get(inv.id) });
});

// Un borrador que nunca se registró sí se borra: no llegó a pasar nada.
app.delete('/api/inversiones/:id', exige('gestionar_inversiones'), (req, res) => {
  const inv = db.prepare('SELECT estado FROM inversiones WHERE id=?').get(req.params.id);
  if (!inv) return res.json({ ok: true });
  if (inv.estado !== 'borrador') return res.status(409).json({
    error: 'Solo se borra un borrador. Una inversión registrada se cancela, para que quede constancia.' });
  db.transaction(() => {
    db.prepare('DELETE FROM inversion_reparto WHERE inversion_id=?').run(req.params.id);
    db.prepare('DELETE FROM inversion_lineas WHERE inversion_id=?').run(req.params.id);
    db.prepare('DELETE FROM inversiones WHERE id=?').run(req.params.id);
  })();
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════
//  SALVAS: verlas, hacer una a mano y llevársela
// ═══════════════════════════════════════════════════════════════
// Una salva es la base de datos entera: quien la tenga, lo tiene todo. Por eso
// pide el permiso más alto que hay.
app.get('/api/salvas', exige('copias'), (req, res) => {
  res.json({ salvas: listarSalvas(), carpeta: RUTA_SALVAS,
             cada_horas: SALVAS_CADA, guardar: SALVAS_GUARDAR });
});

app.post('/api/salvas', exige('copias'), async (req, res) => {
  try { res.json({ ok: true, archivo: await salvar('a mano'), salvas: listarSalvas() }); }
  catch (e) { res.status(500).json({ error: 'No se pudo salvar: ' + e.message }); }
});

// Descargarla, para poder guardarla en otro sitio: una copia que vive en el
// mismo disco que el original no salva de que ese disco se rompa.
app.get('/api/salvas/:archivo', exige('copias'), (req, res) => {
  // El nombre se comprueba contra el patrón, no se limpia: así no hay forma de
  // pedir un archivo de otra carpeta escribiendo «../» en la dirección.
  const f = String(req.params.archivo);
  if (!/^dp-\d{8}-\d{4}\.db$/.test(f)) return res.status(400).json({ error: 'Nombre no válido' });
  const ruta = path.join(RUTA_SALVAS, f);
  if (!fs.existsSync(ruta)) return res.status(404).json({ error: 'Esa salva ya no está' });
  res.download(ruta, f);
});

// ─── RESÚMENES POR PERÍODO ────────────────────────────────────
// Un solo sitio o todos. Los costos y las ganancias solo salen si el cargo
// tiene permiso para verlos (DECISIONES.md #10).
app.get('/api/resumen', exige('ver_informes'), (req, res) => {
  const desde = req.query.desde || '0000-01-01';
  const hasta = req.query.hasta || '9999-12-31';
  const sitio = req.query.sitio_id || null;   // vacío = todos los que pueda ver
  const verGan = puede(req, 'ver_ganancias');

  // Qué locales entran. Si se pide uno, ese —y el guardián de arriba ya se
  // encargó de que sea uno suyo—. Si no se pide ninguno, «todos» significa todos
  // los que puede ver quien pregunta: sin «Ver TODOS los sitios», el resumen es
  // el de su tienda y no el del negocio (DECISIONES.md #39).
  const puedeVer = idsQueVe(req);
  const lista = sitio ? [sitio] : (puedeVer || []);

  // Trozo de SQL y parámetros para filtrar por sitio sin repetirlo diez veces
  const filtro = (campo = 'sitio_id') => lista.length
    ? ` AND ${campo} IN (${lista.map(() => '?').join(',')})` : '';
  const args = extra => [desde, hasta].concat(lista).concat(extra || []);

  const ventas = db.prepare(`SELECT * FROM ventas
      WHERE anulada_en IS NULL AND fecha BETWEEN ? AND ?${filtro()}`).all(...args());
  const porMoneda = { CUP: 0, USD: 0 };
  ventas.forEach(v => { porMoneda[v.moneda === 'USD' ? 'USD' : 'CUP'] += v.total; });
  const cuentas = enMonedaDelNegocio(ventas);

  // Día a día, también en la moneda del negocio. Se arma aquí y no en SQL
  // porque cada venta lleva su propio cambio congelado.
  const dias1 = new Map();
  for (const v of ventas) {
    const d = dias1.get(v.fecha) || { fecha: v.fecha, cuenta: 0, total: 0, costo: 0, comision: 0 };
    const x = aBase(v.total, v.moneda, v.tasa || tasaUSD());
    d.cuenta++;
    d.total += (x === null ? 0 : x);
    d.costo += v.costo_total;
    d.comision += v.comision;
    dias1.set(v.fecha, d);
  }
  const porDia = [...dias1.values()].sort((a, b) => a.fecha < b.fecha ? -1 : 1);
  if (!verGan) porDia.forEach(d => { d.costo = null; });

  // Lo más vendido, en la moneda del NEGOCIO. No se puede sumar en SQL: el
  // precio de cada movimiento va en la moneda de su venta y el costo va en la
  // del negocio, así que «precio − costo» restaba pesos de dólares. En pantalla
  // salía una ganancia de 592 899 USD sobre 1 070 USD vendidos, que es la clase
  // de número que hace desconfiar de todo lo demás.
  const lineasTop = db.prepare(`SELECT m.producto_id, p.nombre, p.codigo,
        m.cantidad, m.precio_unit, m.costo_unit, v.moneda, v.tasa
      FROM movimientos m JOIN productos p ON p.id=m.producto_id
      LEFT JOIN ventas v ON v.id = m.ref_id
      WHERE m.tipo='venta' AND ${enPie('m')} AND v.anulada_en IS NULL
        AND m.fecha BETWEEN ? AND ?${filtro('m.sitio_id')}`).all(...args());
  const porProducto = new Map();
  for (const f of lineasTop) {
    const t = porProducto.get(f.producto_id) ||
      { nombre: f.nombre, codigo: f.codigo, unidades: 0, total: 0, ganancia: 0 };
    const uds = -f.cantidad;
    const enBase = aBase(uds * f.precio_unit, f.moneda || 'CUP', f.tasa || tasaUSD()) || 0;
    t.unidades += uds;
    t.total += enBase;
    t.ganancia += enBase - uds * f.costo_unit;
    porProducto.set(f.producto_id, t);
  }
  const top = [...porProducto.values()]
    .sort((a, b) => b.total - a.total).slice(0, 15)
    .map(t => Object.assign(t, { total: redondear(t.total, monedaBase()),
      ganancia: verGan ? redondear(t.ganancia, monedaBase()) : null }));

  // EN_PIE y no «anula_a IS NULL»: con esa condición sola, un apunte anulado
  // seguía contando —el que lleva la marca es el contrario, no él— y la misma
  // merma salía con dos cifras distintas según se mirara aquí o en el desglose
  // por sitio de /api/negocio.
  const sumaMov = (tipo, campo) => db.prepare(`SELECT COALESCE(SUM(${campo}),0) v
      FROM movimientos WHERE tipo=? AND ${EN_PIE} AND fecha BETWEEN ? AND ?${filtro()}`)
    .get(tipo, ...args()).v;

  // El fondo, de los locales que entren: el que se haya pedido, o los que pueda
  // ver quien pregunta
  const fondo = db.prepare(`SELECT tipo, subtipo, moneda, COALESCE(SUM(importe),0) total
      FROM fondo WHERE fecha BETWEEN ? AND ?${filtro()} GROUP BY tipo, subtipo, moneda
      ORDER BY tipo, total DESC`).all(...args());

  const dias = db.prepare(`SELECT fecha, cerrado_en FROM dias
      WHERE fecha BETWEEN ? AND ?${filtro()} AND cerrado_en IS NOT NULL`).all(...args());

  const total = cuentas.vendido;
  const costo = cuentas.costo;
  // Lo que cuesta la gente en el período: las comisiones que generaron estas
  // ventas más los salarios apuntados con fecha de estas fechas (#33).
  const sueldos = pagosALaGente(desde, hasta, lista);
  // Cómo se llama lo que se está mirando. Decir «Todos los sitios» a quien solo
  // ve el suyo sería mentirle sobre lo que tiene delante.
  const comoSeLlama = () => {
    if (!lista.length) return 'Todos los sitios';
    if (lista.length === 1)
      return (db.prepare('SELECT nombre FROM sitios WHERE id=?').get(lista[0]) || {}).nombre
             || 'Tu local';
    return 'Tus locales';
  };
  res.json({
    desde, hasta, ver_todo: !puedeVer,
    sitio: comoSeLlama(),
    ver_ganancias: verGan,
    ventas: {
      cuenta: ventas.length, total,
      moneda_base: monedaBase(),
      costo: verGan ? costo : null,
      ganancia: verGan ? redondear(total - costo, monedaBase()) : null,
      comision: cuentas.comision,
      // El efectivo que entró, por moneda: eso no se junta nunca.
      por_moneda: porMoneda,
      sin_tasa: cuentas.sin_tasa
    },
    personal: verGan ? {
      comision: cuentas.comision,
      sueldos: sueldos.total,
      queda: redondear(total - costo - cuentas.comision - sueldos.total, monedaBase()),
      sin_tasa: sueldos.sin_tasa
    } : null,
    mermas: { valor: verGan ? -sumaMov('merma', 'cantidad * costo_unit') : null,
              unidades: -sumaMov('merma', 'cantidad') },
    compras: { valor: verGan ? sumaMov('compra', 'cantidad * costo_unit') : null,
               unidades: sumaMov('compra', 'cantidad') },
    por_dia: porDia, top_productos: top,
    fondo: verGan ? fondo : [],
    dias_cerrados: dias.length
  });
});

// ─── TODO EL NEGOCIO: sumado arriba, por sitio debajo ─────────
// El dueño mira su negocio desde el ALMACÉN PRINCIPAL: quiere lo de todos los
// puntos junto y, debajo, lo de cada uno por separado. Es la misma pregunta que
// ya contestaba /api/stock/total para la mercancía, pero para todo lo demás: lo
// vendido, lo perdido, lo que entró y el dinero.
//
// Ninguna cifra sale de una columna guardada: todas se suman de los apuntes
// (DECISIONES.md #1), así que esta pantalla no puede contradecir a las otras.
//
// OJO con dos cosas que se parecen y no son lo mismo:
//   · Lo del PERÍODO —vendido, mermas, entradas, retiros— es un FLUJO: lo que
//     pasó entre dos fechas.
//   · La GAVETA de cada punto y el VALOR de su inventario son un SALDO: todo lo
//     que ha entrado y salido allí desde el principio. Meter un saldo dentro de
//     un período daría un número que no es ni lo uno ni lo otro.
// Por eso van en apartados distintos y con su propio rótulo en la pantalla.
//
// Y hay una tercera fila que no es ningún sitio: los retiros, las inversiones y
// los gastos del negocio no se apuntan en ningún punto (sitio_id vacío). Si se
// repartieran entre los puntos, la gaveta de cada uno dejaría de cuadrar con el
// dinero que hay dentro de verdad, que es justo para lo que sirve.
// Lo que se enseña de cada gaveta. Los dos últimos son los traspasos entre
// sitios: en el total del negocio se compensan —sale de uno y entra en otro—,
// pero para una tienda son dinero que entró y dinero que salió de verdad.
// 'ingreso' es el total de lo que entro; los tres de detras son ese mismo
// dinero partido por de donde vino. Se suman aparte y NO se vuelven a sumar en
// el total, o cada peso contaria dos veces.
const CONCEPTOS_FONDO = ['ingreso', 'retiro', 'inversion', 'gasto', 'recibido', 'mandado',
                         'de_ventas', 'de_otros'];

// «soloSitios» es un Set de ids, o null para todos. Se filtra al final y no en
// cada consulta a propósito: así el total sigue siendo la suma de las filas que
// se enseñan (#22), sin una consulta aparte que pudiera decir otra cosa.
function cuentasDelNegocio(desde, hasta, verGan, verDinero, soloSitios) {
  const base = monedaBase();
  const red = n => redondear(n, base);
  const sitios = db.prepare(`SELECT id, nombre, tipo FROM sitios WHERE activo=1
      ORDER BY CASE WHEN id='principal' THEN 0 WHEN tipo='almacen' THEN 1 ELSE 2 END,
               nombre`).all();

  const nuevo = (id, nombre, tipo) => ({
    sitio_id: id, sitio: nombre, tipo,
    ventas: 0, vendido: 0, costo: 0, ganancia: 0, comision: 0, sin_tasa: false,
    // Lo que cuesta la gente, y lo que queda después de pagarla (#33). 'sueldos'
    // son los salarios y adelantos apuntados en el período; la comisión ya va en
    // su propia casilla, arriba, y no se cuenta dos veces.
    sueldos: 0, queda: 0,
    cobrado: { CUP: 0, USD: 0 },
    mermas: { unidades: 0, valor: 0 },
    entradas: { unidades: 0, valor: 0 },
    traslados: { salieron: 0, entraron: 0 },
    inventario: { unidades: 0, valor: 0 },
    gaveta: { CUP: 0, USD: 0 },
    // Los traspasos van en su propia casilla y NO dentro de «ingreso» o
    // «retiro». Para la gaveta de un punto sí es dinero que entra y sale —por
    // eso está—, pero mezclarlo con lo demás haría que una tienda a la que le
    // pasaron dinero pareciera haber vendido más de lo que vendió.
    fondo: { CUP: { ingreso: 0, retiro: 0, inversion: 0, gasto: 0, recibido: 0, mandado: 0,
                    de_ventas: 0, de_otros: 0 },
             USD: { ingreso: 0, retiro: 0, inversion: 0, gasto: 0, recibido: 0, mandado: 0,
                    de_ventas: 0, de_otros: 0 } }
  });
  const por = new Map(sitios.map(s => [s.id, nuevo(s.id, s.nombre, s.tipo)]));
  // Un sitio apagado o borrado que tenga apuntes sigue apareciendo: si no, la
  // suma de las filas no daría el total y nadie sabría dónde está la diferencia.
  const dame = id => {
    const k = id || '';
    if (!por.has(k)) {
      const s = id ? db.prepare('SELECT nombre FROM sitios WHERE id=?').get(id) : null;
      por.set(k, nuevo(id || null,
        id ? ((s && s.nombre) || '(sitio borrado)') : 'De la empresa (sin sitio)',
        id ? 'punto' : 'negocio'));
    }
    return por.get(k);
  };

  // Lo vendido, con el cambio congelado de cada venta (DECISIONES.md #21).
  const hoy = tasaUSD();
  for (const v of db.prepare(`SELECT sitio_id, moneda, tasa, total, costo_total, comision
      FROM ventas WHERE anulada_en IS NULL AND fecha BETWEEN ? AND ?`).all(desde, hasta)) {
    const p = dame(v.sitio_id);
    const x = aBase(v.total, v.moneda, v.tasa || hoy);
    if (x === null) p.sin_tasa = true; else p.vendido += x;
    p.ventas++;
    p.costo += Number(v.costo_total || 0);
    p.comision += Number(v.comision || 0);
    p.cobrado[v.moneda === 'USD' ? 'USD' : 'CUP'] += Number(v.total || 0);
  }

  // Mercancía que se movió en el período. Se cuenta lo que sigue EN PIE: un
  // apunte anulado y su contrario se van los dos, que es lo que de verdad pasó.
  for (const m of db.prepare(`SELECT sitio_id, tipo,
        COALESCE(SUM(cantidad),0) unidades, COALESCE(SUM(cantidad * costo_unit),0) valor
      FROM movimientos WHERE ${EN_PIE} AND fecha BETWEEN ? AND ?
      GROUP BY sitio_id, tipo`).all(desde, hasta)) {
    const p = dame(m.sitio_id);
    if (m.tipo === 'merma') { p.mermas.unidades += -m.unidades; p.mermas.valor += -m.valor; }
    else if (m.tipo === 'compra' || m.tipo === 'devolucion') {
      p.entradas.unidades += m.unidades; p.entradas.valor += m.valor;
    } else if (m.tipo === 'traslado_salida') p.traslados.salieron += -m.unidades;
    else if (m.tipo === 'traslado_entrada') p.traslados.entraron += m.unidades;
  }

  // Lo que hay HOY en cada sitio, al costo pagado. Solo lo que tiene existencia,
  // igual que la pantalla del almacén: un producto en negativo es un descuadre
  // que hay que arreglar, no un valor negativo que restar del patrimonio.
  for (const i of db.prepare(`SELECT sitio_id, COALESCE(SUM(uds),0) unidades,
        COALESCE(SUM(uds * costo),0) valor FROM (
          SELECT m.sitio_id sitio_id, SUM(m.cantidad) uds, p.costo costo
          FROM movimientos m JOIN productos p ON p.id = m.producto_id
          WHERE p.borrado_en IS NULL
          GROUP BY m.sitio_id, m.producto_id HAVING SUM(m.cantidad) > 0)
        GROUP BY sitio_id`).all()) {
    const p = dame(i.sitio_id);
    p.inventario.unidades = i.unidades;
    p.inventario.valor = i.valor;
  }

  // Los salarios y adelantos del período, sitio por sitio. Van por su sitio_id
  // como cualquier otro apunte: los que no son de ningún punto caen en la fila
  // «De la empresa», igual que los retiros y las inversiones.
  for (const f of db.prepare(`SELECT sitio_id, moneda, COALESCE(SUM(importe),0) v
      FROM fondo WHERE es_gente=1 AND COALESCE(ref_tipo,'') <> 'comision'
        AND fecha BETWEEN ? AND ? GROUP BY sitio_id, moneda`).all(desde, hasta)) {
    const p = dame(f.sitio_id);
    const x = aBase(f.v, f.moneda, hoy);
    if (x === null) p.sin_tasa = true; else p.sueldos += x;
  }

  if (verDinero) {
    // La gaveta: saldo de siempre, no del período.
    for (const g of db.prepare(`SELECT sitio_id, moneda,
        COALESCE(SUM(CASE WHEN tipo='ingreso' THEN importe ELSE -importe END),0) saldo
        FROM fondo GROUP BY sitio_id, moneda`).all()) {
      dame(g.sitio_id).gaveta[g.moneda === 'USD' ? 'USD' : 'CUP'] = g.saldo;
    }
    // Y el dinero que se movió en el período, por tipo. Los traspasos se
    // apartan: lo que le pasaron a una tienda no es lo que esa tienda ingresó.
    //
    // Y el dinero que entra se parte por DE DONDE VIENE: de vender por el
    // mostrador o apuntado a mano. Sale del ref_tipo, que cada apunte guarda
    // desde el primer dia; no hace falta ninguna columna nueva.
    for (const f of db.prepare(`SELECT sitio_id, tipo, moneda, COALESCE(ref_tipo,'') origen,
        COALESCE(SUM(importe),0) total FROM fondo WHERE fecha BETWEEN ? AND ?
        GROUP BY sitio_id, tipo, moneda, origen`).all(desde, hasta)) {
      const caja = dame(f.sitio_id).fondo[f.moneda === 'USD' ? 'USD' : 'CUP'];
      if (f.origen === 'traspaso') { caja[f.tipo === 'ingreso' ? 'recibido' : 'mandado'] += f.total; continue; }
      if (caja[f.tipo] !== undefined) caja[f.tipo] += f.total;
      if (f.tipo === 'ingreso')
        caja[f.origen === 'venta' ? 'de_ventas' : 'de_otros'] += f.total;
    }
  }

  // Quien solo manda en su local ve solo su local. La fila «De la empresa» —la
  // de lo que no es de ningún sitio— tampoco es suya, y por eso se va con las
  // demás: su sitio_id es null y no está en la lista.
  const filas = [...por.values()].filter(p => !soloSitios || soloSitios.has(p.sitio_id));
  // El total es la suma de las filas, sin excepciones: si algún día no cuadrara,
  // se vería en la propia pantalla en vez de esconderse en una consulta aparte.
  // Y como se suma DESPUÉS de filtrar, para quien ve un solo local el total es
  // el de su local, no el del negocio con una fila escondida.
  const total = nuevo(null, soloSitios ? 'Lo tuyo' : 'Todo el negocio', 'total');
  for (const p of filas) {
    // La ganancia de un sitio es lo que vendió menos lo que le costó esa
    // mercancía.
    p.ganancia = p.vendido - p.costo;
    // Y lo que queda de esa ganancia después de pagar a la gente de ese sitio.
    p.queda = p.ganancia - p.comision - p.sueldos;
    total.ventas += p.ventas; total.vendido += p.vendido; total.costo += p.costo;
    total.comision += p.comision; total.sueldos += p.sueldos;
    total.sin_tasa = total.sin_tasa || p.sin_tasa;
    for (const m of ['CUP', 'USD']) {
      total.cobrado[m] += p.cobrado[m];
      total.gaveta[m] += p.gaveta[m];
      for (const t of CONCEPTOS_FONDO) total.fondo[m][t] += p.fondo[m][t];
    }
    for (const c of ['mermas', 'entradas']) {
      total[c].unidades += p[c].unidades; total[c].valor += p[c].valor;
    }
    total.traslados.salieron += p.traslados.salieron;
    total.traslados.entraron += p.traslados.entraron;
    total.inventario.unidades += p.inventario.unidades;
    total.inventario.valor += p.inventario.valor;
  }
  total.ganancia = total.vendido - total.costo;
  total.queda = total.ganancia - total.comision - total.sueldos;

  // Redondear al final, nunca antes: redondeando cada fila, la suma de las
  // filas y el total dejarían de coincidir por unos pesos y no habría forma de
  // explicarlo a quien lo está mirando.
  const limpiar = p => {
    p.vendido = red(p.vendido); p.comision = red(p.comision);
    p.costo = verGan ? red(p.costo) : null;
    p.ganancia = verGan ? red(p.ganancia) : null;
    p.sueldos = verGan ? red(p.sueldos) : null;
    p.queda = verGan ? red(p.queda) : null;
    for (const m of ['CUP', 'USD']) p.cobrado[m] = redondear(p.cobrado[m], m);
    for (const c of ['mermas', 'entradas'])
      p[c].valor = verGan ? red(p[c].valor) : null;
    p.inventario.valor = verGan ? red(p.inventario.valor) : null;
    if (!verDinero) { p.gaveta = null; p.fondo = null; }
    else for (const m of ['CUP', 'USD']) {
      p.gaveta[m] = redondear(p.gaveta[m], m);
      for (const t of CONCEPTOS_FONDO) p.fondo[m][t] = redondear(p.fondo[m][t], m);
    }
    return p;
  };
  return { desde, hasta, moneda: base, ver_ganancias: verGan, ver_dinero: verDinero,
           ver_todo: !soloSitios, total: limpiar(total),
           sitios: filas.map(limpiar).filter(p => p.sitio_id !== null || verDinero) };
}

// Las cuentas sitio por sitio. Hasta el 21 de agosto de 2026 esto exigía «Ver
// TODOS los sitios», y era todo o nada: al encargado de una tienda o no se le
// enseñaba nada —y como la pantalla de Dinero pide esto y el fondo A LA VEZ, se
// le quedaba en blanco entera— o se le enseñaba el negocio completo. Ahora entra
// quien pueda ver dinero o informes, y lo que se le contesta son SUS locales
// (DECISIONES.md #39).
//
// Y el dinero de cada fila lo abre 'ver_fondo'. Antes lo abría 'gestionar_dinero',
// que dejó de existir al partir los permisos (#35): desde entonces, quien no
// tuviera además 'ver_ganancias' recibía todas las gavetas en blanco.
app.get('/api/negocio', exige('ver_negocio_entero', 'ver_fondo', 'ver_informes'), (req, res) => {
  const desde = req.query.desde || '0000-01-01';
  const hasta = req.query.hasta || '9999-12-31';
  res.json(cuentasDelNegocio(desde, hasta, puede(req, 'ver_ganancias'),
                             puede(req, 'ver_fondo'), sitiosQueVe(req)));
});

// ─── Sincronización: los tres caminos ─────────────────────────
// Los tres usan el MISMO paquete y la MISMA fusión. Cambia solo por dónde viaja.

app.get('/api/sync/estado', exige('sincronizar'), (req, res) => {
  const cuenta = t => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  res.json({
    instalacion: instalacionId(),
    servidor: ajuste('sync_url') || '',
    usuario: ajuste('sync_usuario') || '',
    marcas: db.prepare('SELECT * FROM sync_marcas ORDER BY ultimo_uso DESC').all(),
    tengo: { movimientos: cuenta('movimientos'), ventas: cuenta('ventas'),
             productos: cuenta('productos'), fondo: cuenta('fondo') }
  });
});

// Olvidar el sello apuntado de otra copia. Hace falta el día que esa copia se
// reinstala desde cero: su sello es nuevo y, con razón, aquí se rechaza. Es un
// botón aparte y no algo automático justamente para que sea una decisión de
// alguien, no un descuido.
app.post('/api/sync/olvidar-sello', exige('sincronizar'), (req, res) => {
  const url = String((req.body && req.body.url) || ajuste('sync_url') || '').trim();
  if (!url) return res.status(400).json({ error: 'Falta la dirección del otro servidor' });
  try {
    db.prepare('DELETE FROM ajustes WHERE clave=?').run('sync_sello:' + new URL(url).host);
    res.json({ ok: true });
  } catch { res.status(400).json({ error: 'Esa dirección no se entiende' }); }
});

app.post('/api/sync/servidor', exige('sincronizar'), (req, res) => {
  ajuste('sync_url', String((req.body && req.body.url) || '').trim().replace(/\/+$/, ''));
  ajuste('sync_usuario', String((req.body && req.body.usuario) || '').trim());
  if (req.body && req.body.pin) ajuste('sync_pin', String(req.body.pin));
  res.json({ ok: true });
});

// 1) ARCHIVO: bajar un paquete para mandarlo por WhatsApp, correo o memoria.
app.get('/api/sync/paquete', exige('sincronizar'), (req, res) => {
  res.json(paqueteDesde(req.query.desde || null, req.query.sitio_id || null));
});

// 2) El otro lado sube su paquete y aquí se funde.
app.post('/api/sync/fusionar', exige('sincronizar'), (req, res) => {
  try {
    const antes = db.prepare('SELECT COUNT(*) n FROM movimientos').get().n;
    const cuenta = fusionar(req.body);
    const de = req.body.instalacion || 'archivo';
    db.prepare(`INSERT INTO sync_marcas (par,ultima,ultimo_uso,resultado) VALUES (?,?,?,?)
        ON CONFLICT(par) DO UPDATE SET ultimo_uso=excluded.ultimo_uso, resultado=excluded.resultado`)
      .run(de, null, ahoraISO(), JSON.stringify(cuenta));
    res.json({ ok: true, aplicado: cuenta,
               movimientos_nuevos: db.prepare('SELECT COUNT(*) n FROM movimientos').get().n - antes });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Mirar con qué sello contesta el otro servidor, sin mandarle nada todavía.
// Se sube por la cadena hasta la raíz porque lo que se apunta es el SELLO DEL
// NEGOCIO, no el certificado del servidor: ese se vuelve a emitir solo cada vez
// que el router reparte otra dirección, y si apuntáramos ese, la sincronización
// se rompería sola cada dos por tres.
function selloRemoto(host, puerto) {
  return new Promise((ok, mal) => {
    const esIP = /^[\d.]+$/.test(host);
    const s = tls.connect({ host, port: Number(puerto), rejectUnauthorized: false,
                            servername: esIP ? undefined : host }, () => {
      let c = s.getPeerCertificate(true), vistos = new Set();
      while (c && c.issuerCertificate && c.issuerCertificate !== c && !vistos.has(c.fingerprint256)) {
        vistos.add(c.fingerprint256);
        c = c.issuerCertificate;
      }
      s.end();
      if (!c || !c.raw) return mal(new Error('el otro servidor no enseñó ningún certificado'));
      ok({ huella: c.fingerprint256,
           pem: '-----BEGIN CERTIFICATE-----\n' +
                c.raw.toString('base64').match(/.{1,64}/g).join('\n') +
                '\n-----END CERTIFICATE-----\n' });
    });
    s.setTimeout(15000, () => { s.destroy(); mal(new Error('el otro servidor no contesta')); });
    s.on('error', e => mal(new Error('no se pudo llegar al otro servidor: ' + e.message)));
  });
}

// Igual que fetch, pero comprobando el sello apuntado. No se usa fetch porque
// no deja decirle en qué sello confiar, y con el candado puesto rechazaría a
// todas las demás copias.
function pedirA(direccion, opciones = {}, sello = null) {
  const u = new URL(direccion);
  const seguro = u.protocol === 'https:';
  const conf = { method: opciones.method || 'GET', headers: opciones.headers || {} };
  if (seguro) {
    conf.ca = [sello];
    // El nombre no se comprueba: lo que garantiza que es él es el sello, y la
    // dirección puede ser una IP que cambia sola con el router.
    conf.checkServerIdentity = () => undefined;
  }
  return new Promise((ok, mal) => {
    const req = (seguro ? https : http).request(u, conf, r => {
      let cuerpo = '';
      r.setEncoding('utf8');
      r.on('data', d => { cuerpo += d; });
      r.on('end', () => ok({ status: r.statusCode, cuerpo }));
    });
    req.setTimeout(120000, () => req.destroy(new Error('el otro servidor tardó demasiado')));
    req.on('error', e => mal(new Error(e.message)));
    req.end(opciones.body);
  });
}

// 3) SERVIDOR: hablar con otra copia por internet o por el WiFi del almacén.
// Lo hace el servidor y no el navegador, para no depender de permisos de
// origen cruzado y para que funcione aunque el aparato se apague a mitad.
app.post('/api/sync/ahora', exige('sincronizar'), async (req, res) => {
  const url = (req.body && req.body.url) || ajuste('sync_url');
  const usuario = (req.body && req.body.usuario) || ajuste('sync_usuario');
  const pin = (req.body && req.body.pin) || ajuste('sync_pin');
  if (!url) return res.status(400).json({ error: 'Falta la dirección del otro servidor' });

  // Con el candado puesto, cada copia tiene su propio sello y node no se fía de
  // ninguno: sin esto, la sincronización por red dejaría de funcionar el día que
  // se pasó a HTTPS. Se hace como SSH: la PRIMERA vez se apunta con quién se
  // habla, y a partir de ahí solo se acepta a ese. Si mañana contesta otro sello,
  // se para y se avisa, en vez de mandarle el usuario y el PIN a un desconocido.
  let sello = null;
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') {
      const clave = 'sync_sello:' + u.host;
      const guardado = ajuste(clave);
      const visto = await selloRemoto(u.hostname, u.port || 443);
      if (!guardado) { ajuste(clave, visto.pem); sello = visto.pem; }
      else if (guardado.trim() !== visto.pem.trim())
        throw new Error('El otro servidor contesta con un sello DISTINTO al de la primera vez. ' +
          'O lo reinstalaron desde cero, o no es quien dice ser. No se le mandó nada. ' +
          'Si de verdad lo reinstalaron, hay que olvidar el sello viejo en Ajustes.');
      else sello = guardado;
    }
  } catch (e) {
    db.prepare(`INSERT INTO sync_marcas (par,ultima,ultimo_uso,resultado) VALUES (?,NULL,?,?)
        ON CONFLICT(par) DO UPDATE SET ultimo_uso=excluded.ultimo_uso, resultado=excluded.resultado`)
      .run(url, ahoraISO(), 'error: ' + e.message);
    return res.status(400).json({ error: e.message });
  }

  const pedir = async (ruta, opciones) => {
    const r = await pedirA(url + ruta, opciones, sello);
    const c = (() => { try { return JSON.parse(r.cuerpo); } catch { return {}; } })();
    if (r.status < 200 || r.status >= 300)
      throw new Error((c.error || 'el otro servidor respondió ' + r.status));
    return c;
  };
  try {
    const ses = await pedir('/api/auth/entrar', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario, pin, aparato: 'sync ' + instalacionId().slice(0, 8) }) });
    const cab = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ses.token };

    // Mandar lo mío desde la última vez, y traerme lo suyo
    const marca = db.prepare('SELECT ultima FROM sync_marcas WHERE par=?').get(url);
    const mio = paqueteDesde(marca ? marca.ultima : null);
    const subida = await pedir('/api/sync/fusionar', {
      method: 'POST', headers: cab, body: JSON.stringify(mio) });
    const suyo = await pedir('/api/sync/paquete' + (marca && marca.ultima ? '?desde=' + encodeURIComponent(marca.ultima) : ''),
      { headers: cab });
    const bajada = fusionar(suyo);

    const ahora = ahoraISO();
    db.prepare(`INSERT INTO sync_marcas (par,ultima,ultimo_uso,resultado) VALUES (?,?,?,?)
        ON CONFLICT(par) DO UPDATE SET ultima=excluded.ultima, ultimo_uso=excluded.ultimo_uso,
          resultado=excluded.resultado`)
      .run(url, ahora, ahora, 'ok');
    res.json({ ok: true, subido: subida.aplicado || {}, bajado: bajada });
  } catch (e) {
    db.prepare(`INSERT INTO sync_marcas (par,ultima,ultimo_uso,resultado) VALUES (?,NULL,?,?)
        ON CONFLICT(par) DO UPDATE SET ultimo_uso=excluded.ultimo_uso, resultado=excluded.resultado`)
      .run(url, ahoraISO(), 'error: ' + e.message);
    res.status(400).json({ error: e.message });
  }
});

// ─── La salva automática ─────────────────────────────────────────────────────
// Una al arrancar y otra cada pocas horas. La de arranque importa más de lo que
// parece: la máquina de un local se apaga y se enciende todos los días, así que
// es la que garantiza que siempre haya una copia reciente aunque el programa no
// llegue a estar seis horas seguidas vivo.
if (SALVAS_CADA > 0) {
  const hacer = motivo => salvar(motivo).catch(e => console.error('[salva] falló:', e.message));
  setTimeout(() => hacer('al arrancar'), 8000).unref();
  setInterval(() => hacer('cada ' + SALVAS_CADA + ' h'), SALVAS_CADA * 3600000).unref();
}

// ─── Arranque: HTTPS y HTTP en el MISMO puerto ───────────────────────────────
// Por qué en el mismo: la gente ya se sabe una dirección. Si HTTPS se fuera a
// otro puerto, quien escriba la de siempre vería un error incomprensible. Aquí
// se mira el primer byte que llega —un saludo TLS empieza por 0x16— y se manda
// a un sitio o al otro. Así:
//     https://…:3010  →  la aplicación
//     http://…:3010   →  la página que explica cómo instalar el sello
// Y de paso no hay que abrir un segundo puerto en el cortafuegos.
// Dos formas de ir sin sello propio:
//   DP_TRAS_PROXY=1  detrás de nginx con certificado de verdad. El candado lo
//                    pone nginx, y aquí dentro sobra: el sello del negocio solo
//                    sirve para los aparatos del negocio (DECISIONES.md #13).
//   DP_HTTP=1        salida de emergencia, sin candado de ninguna clase.
const TRAS_PROXY = process.env.DP_TRAS_PROXY === '1';
const SIN_CANDADO = TRAS_PROXY || process.env.DP_HTTP === '1';
const cert = SIN_CANDADO ? null : certificados.cargar(console.log);

const banner = () => {
  const donde = cert ? 'https' : 'http';
  console.log('');
  console.log('  ▪  D´Padrones');
  console.log('     ' + donde + '://localhost:' + PUERTO);
  if (cert) {
    for (const ip of cert.ips) console.log('     https://' + ip + ':' + PUERTO + '   (desde los teléfonos)');
    if (!cert.ips.length) console.log('     (esta máquina no está en ninguna red: solo se ve desde aquí)');
    console.log('');
    console.log('  🔑 Cada aparato nuevo tiene que instalar el sello UNA vez:');
    console.log('     http://' + (cert.ips[0] || 'localhost') + ':' + PUERTO + '   (sin la s)');
  } else if (TRAS_PROXY) {
    console.log('');
    console.log('  🔒 Detrás de un proxy: el candado lo pone nginx.');
    console.log('     Aquí solo se escucha en ' + ESCUCHA + ', que no sale a internet.');
  } else {
    console.log('');
    console.log('  ⚠  SIN CANDADO: el PIN viaja en claro por la red, la cámara no');
    console.log('     funciona y la aplicación no puede trabajar sin internet.');
  }
  console.log('');
};

// Detrás de nginx conviene atarla a 127.0.0.1: al puerto solo se llega por el
// proxy, y nadie puede saltárselo entrando por la IP.
const ESCUCHA = process.env.DP_HOST || '0.0.0.0';

let servidor;
if (cert) {
  const seguro = https.createServer({ key: cert.key, cert: cert.cert }, app);

  // La puerta de entrada sin candado: solo sabe dar el sello y explicar.
  const claro = http.createServer((req, res) => {
    const maquina = String(req.headers.host || '').split(':')[0] || cert.ips[0] || 'localhost';
    const destino = 'https://' + maquina + ':' + PUERTO + '/';
    if (req.url.startsWith('/sello-del-negocio.crt')) {
      res.writeHead(200, {
        'Content-Type': 'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename="sello-del-negocio.crt"',
      });
      return res.end(cert.ca);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(certificados.paginaDeInstalacion({ destino, huella: cert.huellaCA }));
  });

  servidor = net.createServer(socket => {
    socket.on('error', () => {});                       // un aparato que se va no debe tumbar nada
    socket.setTimeout(20000, () => socket.destroy());   // ni uno que se conecta y no dice nada
    socket.once('data', primero => {
      socket.setTimeout(0);
      socket.pause();
      socket.unshift(primero);
      (primero[0] === 0x16 ? seguro : claro).emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  });
  servidor.listen(PUERTO, ESCUCHA, banner);
} else {
  servidor = app.listen(PUERTO, ESCUCHA, banner);
}

// Si el puerto ya está cogido, node se muere con un error críptico. Y si eso
// pasa sin que nadie lo vea, sigue respondiendo el servidor VIEJO: la app
// parece rota de formas imposibles de entender (rutas que existen y dan 404).
// Costó una tarde averiguarlo, así que ahora se dice claro.
servidor.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error('');
    console.error('  ⚠  EL PUERTO ' + PUERTO + ' YA ESTÁ OCUPADO');
    console.error('');
    console.error('  Hay otro D´Padrones corriendo. Ese seguirá respondiendo,');
    console.error('  probablemente con una versión vieja del programa.');
    console.error('');
    console.error('  Ciérralo antes de arrancar este. En Windows:');
    console.error('      taskkill /F /IM node.exe');
    console.error('');
  } else {
    console.error('No se pudo arrancar:', e.message);
  }
  process.exit(1);
});
