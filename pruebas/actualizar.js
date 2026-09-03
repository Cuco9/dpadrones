// ACTUALIZAR UNA BASE VIEJA — lo que le pasa al VPS en cada despliegue.
//
// Por qué existe este banco: el 14 de agosto de 2026 se subió el trabajo del día
// con todas las comprobaciones en verde, y hubo que restaurar la salva. Todas esas
// comprobaciones arrancan SIEMPRE con una base recién creada; en el VPS hay una
// base con meses de datos dentro que se actualiza. Eso no lo miraba nadie.
//
// Lo que hace, en este orden:
//   1. Saca de git el código que está DESPLEGADO (pruebas/version-desplegada.txt)
//      y con él fabrica una base y la llena con datos de verdad.
//   2. Le pasa por encima el código de ahora, que es lo que hace `git pull`.
//   3. Comprueba que el esquema queda IGUAL que el de una base creada desde cero
//      —ahí salen las columnas que se añadieron al esquema y se olvidó migrar—,
//      que no se perdió ningún dato, y que TODAS las pantallas contestan.
//
// Si falla el paso 3, el despliegue rompería el negocio. No se sube.
//
//   node pruebas/actualizar.js
//
// La versión desplegada se apunta en pruebas/version-desplegada.txt cada vez que
// se sube algo (lo recuerda DESPLIEGUE.md). Se puede probar contra otra con:
//   DP_DESDE=abc1234 node pruebas/actualizar.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const raiz = path.join(__dirname, '..');
const patio = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-act-'));
const Database = require('better-sqlite3');

let ok = 0, mal = 0;
const comp = (nombre, cierto, extra) => {
  if (cierto) { ok++; console.log('  ok   ' + nombre); }
  else { mal++; console.log('  MAL  ' + nombre + (extra !== undefined ? '  → ' + extra : '')); }
};

const puertoLibre = () => new Promise(res => {
  const s = require('net').createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const procesos = [];
function arrancar(cwd, env) {
  const p = spawn(process.execPath, ['server.js'], {
    cwd, env: Object.assign({}, process.env, env), stdio: ['ignore', 'pipe', 'pipe'] });
  procesos.push(p);
  let salida = '';
  const listo = new Promise((res, rej) => {
    const mirar = d => { salida += d; if (/D´Padrones/.test(salida)) res(salida); };
    p.stdout.on('data', mirar);
    p.stderr.on('data', mirar);
    p.on('exit', c => rej(new Error('server.js se murió (' + c + '):\n' + salida)));
    setTimeout(() => rej(new Error('server.js no arrancó a tiempo:\n' + salida)), 60000);
  });
  return { proceso: p, listo, texto: () => salida };
}
const cerrarTodo = () => procesos.forEach(p => { try { p.kill(); } catch (e) {} });

let BASE, cab = {};
async function pedir(ruta, opciones = {}) {
  const conf = Object.assign({}, opciones);
  conf.headers = Object.assign({ 'Content-Type': 'application/json' }, cab, opciones.headers || {});
  try {
    const r = await fetch(BASE + ruta, conf);
    const txt = await r.text();
    let cuerpo; try { cuerpo = JSON.parse(txt); } catch (e) { cuerpo = txt.slice(0, 200); }
    return { status: r.status, cuerpo };
  } catch (e) { return { status: 0, cuerpo: 'no contestó: ' + e.message }; }
}
const post = (ruta, cuerpo) => pedir(ruta, { method: 'POST', body: JSON.stringify(cuerpo) });
const dia = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

// Copiar una base de SQLite copiando el archivo NO vale: con el WAL aparte sale
// una base vacía que parece buena. Es la misma razón por la que DESPLIEGUE.md
// manda usar `sqlite3 .backup` y no `cp`.
function copiarBase(origen, destino) {
  const d = new Database(origen, { readonly: true });
  d.prepare('VACUUM INTO ?').run(destino);
  d.close();
}

function esquema(ruta) {
  const db = new Database(ruta, { readonly: true });
  const mapa = {};
  for (const o of db.prepare(
      "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all()) {
    mapa[o.type + ':' + o.name] = o.type !== 'table' ? ['(existe)']
      : db.prepare(`PRAGMA table_info(${o.name})`).all().map(c =>
          `${c.name} ${c.type}${c.notnull ? ' NOT NULL' : ''}` +
          `${c.dflt_value != null ? ' DEF ' + c.dflt_value : ''}`);
  }
  db.close();
  return mapa;
}

function cuentas(ruta) {
  const db = new Database(ruta, { readonly: true });
  const n = {};
  for (const t of ['sitios', 'productos', 'movimientos', 'ventas', 'fondo',
                   'personas', 'inversiones', 'clientes', 'cobros']) {
    try { n[t] = db.prepare('SELECT COUNT(*) n FROM ' + t).get().n; } catch (e) { n[t] = -1; }
  }
  db.close();
  return n;
}

// Saca del historial los tres archivos que hacen falta para levantar el servidor
// de esa versión. No se usa `git checkout` para no tocar el árbol de trabajo.
function sacarDeGit(commit, destino) {
  fs.mkdirSync(path.join(destino, 'db'), { recursive: true });
  for (const [ruta, guardar] of [['server.js', 'server.js'],
                                 ['certificados.js', 'certificados.js'],
                                 ['db/esquema.sql', path.join('db', 'esquema.sql')]]) {
    const r = spawnSync('git', ['show', commit + ':' + ruta], { cwd: raiz, encoding: 'buffer' });
    if (r.status !== 0) throw new Error('git show ' + commit + ':' + ruta + ' falló');
    fs.writeFileSync(path.join(destino, guardar), r.stdout);
  }
}

(async () => {
  try {
    const archivoVersion = path.join(__dirname, 'version-desplegada.txt');
    const DESDE = (process.env.DP_DESDE ||
      (fs.existsSync(archivoVersion) ? fs.readFileSync(archivoVersion, 'utf8') : ''))
      .split('\n')[0].trim().replace(/^#.*/, '');

    if (!DESDE) {
      console.log('\n(sin versión desplegada apuntada en pruebas/version-desplegada.txt:');
      console.log(' no hay contra qué comparar. Se salta este banco.)');
      process.exit(0);
    }
    const existe = spawnSync('git', ['cat-file', '-e', DESDE + '^{commit}'], { cwd: raiz });
    if (existe.status !== 0) {
      console.log('\n(no encuentro el commit ' + DESDE + ' en el historial. Se salta este banco.)');
      process.exit(0);
    }

    console.log('\n=== Se fabrica una base con el código QUE ESTÁ DESPLEGADO (' + DESDE + ') ===');
    const viejo = path.join(patio, 'desplegado');
    sacarDeGit(DESDE, viejo);
    const dbVieja = path.join(patio, 'vieja.db');
    const p1 = await puertoLibre();
    const s1 = arrancar(viejo, { PUERTO: p1, DP_DB: dbVieja, DP_HTTP: '1',
      DP_HOST: '127.0.0.1', DP_SALVAS: path.join(patio, 'salvas1'),
      NODE_PATH: path.join(raiz, 'node_modules') });
    await s1.listo;
    BASE = 'http://127.0.0.1:' + p1;
    comp('el servidor desplegado arranca', true);

    await post('/api/auth/crear-admin', { nombre: 'Jefe', usuario: 'jefe', pin: '123456' });
    const ses = await post('/api/auth/entrar', { usuario: 'jefe', pin: '123456' });
    cab = { Authorization: 'Bearer ' + ses.cuerpo.token };
    comp('se entra con el PIN', !!ses.cuerpo.token, JSON.stringify(ses.cuerpo));

    await post('/api/tasa', { tasa: 400 });
    const almacen = (await pedir('/api/sitios')).cuerpo[0].id;
    const punto = (await post('/api/sitios',
      { nombre: 'Punto Centro', tipo: 'punto', padre_id: almacen })).cuerpo.id;
    const punto2 = (await post('/api/sitios',
      { nombre: 'Punto Vedado', tipo: 'punto', padre_id: almacen })).cuerpo.id;
    const inv5 = (await post('/api/productos', { nombre: 'Inversor 5kW', precio: 500,
      precio_moneda: 'USD', costo: 120000 })).cuerpo.id;
    const cable = (await post('/api/productos',
      { nombre: 'Cable 10mm', precio: 800, costo: 400 })).cuerpo.id;
    const panel = (await post('/api/productos', { nombre: 'Panel 450W', precio: 250,
      precio_moneda: 'USD', costo: 60000 })).cuerpo.id;
    comp('se crean los sitios y el catálogo', !!(punto && punto2 && inv5 && cable && panel));

    // El dinero, antes de comprar nada: desde el 21 de agosto de 2026 no se saca de
    // una gaveta lo que no tiene dentro (DECISIONES.md #38), y el código desplegado
    // ya lo lleva. Sembrar sin esto deja la base sin inversión y sin mercancía, y el
    // banco entero comparando dos bases vacías.
    await post('/api/fondo', { tipo: 'ingreso', subtipo: 'Aporte de socio', moneda: 'USD',
      importe: 20000, sitio_id: almacen, concepto: 'Capital para empezar', fecha: dia(40) });

    // Una inversión registrada: mete mercancía en los sitios y saca dinero del fondo
    const i = await post('/api/inversiones', {
      nombre: 'Contenedor de agosto', proveedor: 'Importadora XY', moneda: 'USD', fecha: dia(30),
      sitio_id: almacen,
      lineas: [
        { producto_id: inv5, cantidad: 10, costo_unit: 300,
          reparto: [{ sitio_id: almacen, cantidad: 6 }, { sitio_id: punto, cantidad: 4 }] },
        { producto_id: cable, cantidad: 200, costo_unit: 1,
          reparto: [{ sitio_id: punto, cantidad: 80 }, { sitio_id: punto2, cantidad: 40 }] },
        { producto_id: panel, cantidad: 20, costo_unit: 150,
          reparto: [{ sitio_id: punto, cantidad: 10 }, { sitio_id: punto2, cantidad: 5 }] },
      ] });
    await post('/api/inversiones/' + i.cuerpo.id + '/registrar', {});
    comp('se registra una inversión con su reparto', i.status === 200, JSON.stringify(i.cuerpo));

    // Ventas en las dos monedas, en dos sitios y en días distintos
    for (const v of [
      { sitio_id: punto,  moneda: 'USD', fecha: dia(10), lineas: [{ producto_id: inv5, cantidad: 1 }] },
      { sitio_id: punto,  moneda: 'CUP', fecha: dia(5),  lineas: [{ producto_id: cable, cantidad: 20 }] },
      { sitio_id: punto2, moneda: 'USD', fecha: dia(3),  lineas: [{ producto_id: panel, cantidad: 2 }] },
      { sitio_id: punto,  moneda: 'CUP', lineas: [{ producto_id: cable, cantidad: 10 },
                                                  { producto_id: panel, cantidad: 1 }] },
    ]) await post('/api/ventas', v);
    await post('/api/fondo', { tipo: 'ingreso', concepto: 'Aporte del dueño', importe: 500,
      moneda: 'USD', sitio_id: almacen });
    await post('/api/clientes', { nombre: 'Ana Pérez', telefono: '55512345' });

    s1.proceso.kill();
    await new Promise(r => setTimeout(r, 600));

    // Un retiro SIN sitio, escrito a mano en la base. Hasta el 17 de agosto de 2026
    // se podían apuntar así (DECISIONES.md #37), y en la base de él los hay: esta
    // línea es la que comprueba que sobreviven a la actualización y siguen contando.
    // Ya no se puede sembrar por la puerta —el código desplegado los rechaza—, así
    // que se mete como está en la base de verdad, que es de lo que se trata.
    const vieja = new Database(dbVieja);
    vieja.prepare(`INSERT INTO fondo (id,tipo,subtipo,moneda,importe,sitio_id,concepto,fecha,ts,creado_en)
        VALUES (?,'retiro','Local','CUP',30000,NULL,'Pago de local',?,?,?)`)
      .run(require('crypto').randomUUID(), dia(8), Date.now(), new Date().toISOString());
    vieja.close();

    const antes = cuentas(dbVieja);
    comp('la base vieja queda con datos de verdad dentro',
      antes.ventas >= 4 && antes.movimientos > 0 && antes.fondo > 0, JSON.stringify(antes));

    console.log('\n=== Y ahora se le pasa por encima el código de AHORA (esto es el git pull) ===');
    const dbActualizada = path.join(patio, 'actualizada.db');
    copiarBase(dbVieja, dbActualizada);
    const p2 = await puertoLibre();
    const s2 = arrancar(raiz, { PUERTO: p2, DP_DB: dbActualizada, DP_HTTP: '1',
      DP_HOST: '127.0.0.1', DP_SALVAS: path.join(patio, 'salvas2') });
    await s2.listo;
    BASE = 'http://127.0.0.1:' + p2;
    comp('el código de ahora arranca sobre la base vieja', true);
    comp('y no se queja al migrarla',
      !/Error|SQLITE_|no such (table|column)/i.test(s2.texto()),
      (s2.texto().match(/.*(Error|SQLITE_|no such).*/i) || [''])[0]);

    const despues = cuentas(dbActualizada);
    // Lo que no puede pasar es PERDER: una tabla que existía no puede quedarse
    // con menos filas, ni desaparecer (que aquí se cuenta como −1). Que una tabla
    // pase de no existir a existir VACÍA no es una pérdida: es una tabla nueva
    // del cambio que se está desplegando, y exigir que las dos cuentas sean
    // idénticas obligaba a tocar esta prueba cada vez que nace una tabla —por el
    // motivo equivocado, y con el riesgo de acostumbrarse a cambiarla sin mirar—.
    const perdidas = Object.keys(antes).filter(t => antes[t] >= 0 && despues[t] < antes[t]);
    comp('no se pierde ni un dato al actualizar', perdidas.length === 0,
      'pierden filas: ' + perdidas.join(', ') + ' · antes ' + JSON.stringify(antes) +
      ' · después ' + JSON.stringify(despues));
    // LA MIGRACIÓN DE LO QUE SE FÍA, mirada sobre una base VIEJA de verdad y no
    // sobre una recién creada: hasta ese cambio toda venta se cobraba entera en
    // el acto, así que a cada una le tiene que tocar un cobro por su total. Si se
    // quedara alguna sin él, aparecería como pendiente de cobro un dinero que se
    // pagó hace meses, y el dueño saldría a cobrarle a un cliente que no debe nada.
    const rev = new Database(dbActualizada, { readonly: true });
    const ventasVivas = rev.prepare(
      'SELECT COUNT(*) n, COALESCE(SUM(total),0) t FROM ventas WHERE anulada_en IS NULL').get();
    const cobrado = rev.prepare('SELECT COUNT(*) n, COALESCE(SUM(importe),0) t FROM cobros').get();
    const sinCobro = rev.prepare(`SELECT COUNT(*) n FROM ventas v WHERE v.anulada_en IS NULL
        AND NOT EXISTS (SELECT 1 FROM cobros c WHERE c.venta_id=v.id)`).get().n;
    const fechasRaras = rev.prepare(`SELECT COUNT(*) n FROM cobros c
        JOIN ventas v ON v.id=c.venta_id WHERE c.fecha <> v.fecha`).get().n;
    rev.close();
    comp('cada venta de antes queda con su cobro', sinCobro === 0 && cobrado.n === ventasVivas.n,
      'ventas ' + ventasVivas.n + ' · cobros ' + cobrado.n + ' · sin cobro ' + sinCobro);
    comp('y por el importe entero, ni un peso de más ni de menos',
      Math.abs(cobrado.t - ventasVivas.t) < 0.005,
      'ventas ' + ventasVivas.t + ' · cobros ' + cobrado.t);
    // Con la fecha de HOY, el efectivo de todos los días anteriores se mudaría al
    // día del despliegue y no volvería a cuadrar ni un cierre de los ya cerrados.
    comp('con la fecha de SU venta, no la del día del despliegue', fechasRaras === 0,
      fechasRaras + ' cobro(s) con otra fecha');

    console.log('\n=== El esquema tiene que quedar igual que uno recién creado ===');
    // Aquí es donde salta una columna que se añadió a db/esquema.sql y se olvidó
    // migrar: la base nueva la tiene y la del VPS no, y el día del despliegue la
    // pantalla que la use se queda sin datos.
    const dbNueva = path.join(patio, 'desde-cero.db');
    const p3 = await puertoLibre();
    const s3 = arrancar(raiz, { PUERTO: p3, DP_DB: dbNueva, DP_HTTP: '1',
      DP_HOST: '127.0.0.1', DP_SALVAS: path.join(patio, 'salvas3') });
    await s3.listo;
    s3.proceso.kill();

    const A = esquema(dbActualizada), B = esquema(dbNueva);
    const faltan = [];
    for (const clave of Object.keys(B)) {
      if (!A[clave]) { faltan.push('falta entero ' + clave); continue; }
      for (const col of B[clave]) if (!A[clave].includes(col)) faltan.push(clave + ' → ' + col);
    }
    comp('la base actualizada no tiene menos que una nueva', faltan.length === 0,
      faltan.slice(0, 6).join(' ; '));

    console.log('\n=== Y todas las pantallas contestan, con los datos viejos dentro ===');
    const ses2 = await post('/api/auth/entrar', { usuario: 'jefe', pin: '123456' });
    cab = { Authorization: 'Bearer ' + ses2.cuerpo.token };
    comp('la sesión sigue valiendo tras actualizar', !!ses2.cuerpo.token,
      JSON.stringify(ses2.cuerpo));

    const sitios = (await pedir('/api/sitios')).cuerpo;
    const alm = sitios[0].id, pun = (sitios[1] || sitios[0]).id;
    const hoy = dia(0), hace30 = dia(30);
    const lista = (await pedir('/api/inversiones')).cuerpo;
    const idInv = ((Array.isArray(lista) ? lista : lista.inversiones || [])[0] || {}).id;
    const rutas = [
      '/api/salud', '/api/auth/estado', '/api/auth/yo', '/api/marca', '/api/tasa',
      '/api/sitios', '/api/cargos', '/api/productos', '/api/denominaciones',
      '/api/stock?sitio_id=' + alm, '/api/stock?sitio_id=' + pun, '/api/stock/total',
      '/api/dia?sitio_id=' + pun, '/api/dia/teorico?sitio_id=' + pun,
      '/api/ventas?sitio_id=' + pun, '/api/traslados?sitio_id=' + pun,
      '/api/fondo', '/api/fondo?sitio_id=' + pun,
      '/api/resumen?desde=' + hace30 + '&hasta=' + hoy,
      '/api/resumen?desde=' + hace30 + '&hasta=' + hoy + '&sitio_id=' + pun,
      '/api/negocio?desde=' + hace30 + '&hasta=' + hoy,
      '/api/comisiones?desde=' + hace30 + '&hasta=' + hoy,
      '/api/inversiones', idInv ? '/api/inversiones/' + idInv : null,
      '/api/avisos', '/api/salvas', '/api/sync/estado',
      '/api/borrar/vista-previa',
    ].filter(Boolean);
    let rotas = [];
    for (const ruta of rutas) {
      const r = await pedir(ruta);
      if (r.status !== 200) rotas.push(ruta + ' (' + r.status + ')');
    }
    comp('las ' + rutas.length + ' pantallas contestan', rotas.length === 0, rotas.join(' ; '));

    console.log('\n=== Los nombres que la pantalla LEE siguen existiendo ===');
    // El 13 de agosto de 2026 el servidor pasó a mandar 'por_moneda' y la pantalla
    // seguía leyendo 'por_pago': «Cierre → Período» salía en blanco. El 14 pasó
    // otra vez, al revés: la pantalla pasó a leer 'caja' y el servidor seguía
    // mandando 'gaveta', y «Detalle por sitio» se quedó vacío. Las dos veces el
    // servidor contestó 200 y ninguna prueba se enteró, porque mirar el número de
    // respuesta no dice nada de CÓMO se llaman los datos que trae dentro.
    const hay = (obj, camino) => camino.split('.').reduce(
      (o, k) => (o == null ? undefined : o[k]), obj) !== undefined;
    const neg = (await pedir('/api/negocio?desde=' + hace30 + '&hasta=' + hoy)).cuerpo;
    const fon = (await pedir('/api/fondo?desde=' + hace30 + '&hasta=' + hoy)).cuerpo;
    const res = (await pedir('/api/resumen?desde=' + hace30 + '&hasta=' + hoy)).cuerpo;
    const jor = (await pedir('/api/dia?sitio_id=' + pun)).cuerpo;
    const unSitio = (neg.sitios || [])[0] || {};
    for (const [donde, obj, campos] of [
      ['/api/negocio', neg, ['sitios', 'total', 'total.gaveta.CUP', 'total.gaveta.USD',
                             'total.inventario.valor', 'total.vendido', 'total.ganancia',
                             'total.mermas.valor', 'total.entradas.valor', 'ver_ganancias',
                             'ver_dinero', 'desde', 'hasta']],
      ['/api/negocio (un sitio)', unSitio, ['sitio', 'tipo', 'gaveta.CUP', 'gaveta.USD',
                             'fondo.CUP.ingreso', 'fondo.CUP.recibido', 'fondo.CUP.mandado',
                             'fondo.USD.retiro', 'fondo.USD.inversion', 'fondo.USD.gasto',
                             'inventario.unidades', 'traslados.salieron', 'ventas',
                             'gaveta_inicio.CUP', 'gaveta_inicio.USD']],
      ['/api/fondo', fon, ['saldo.CUP', 'saldo.USD', 'gavetas', 'movimientos', 'resumen']],
      ['/api/resumen', res, ['ventas.por_moneda.CUP', 'ventas.por_moneda.USD', 'ventas.total',
                             'ventas.cuenta', 'por_dia', 'top_productos', 'mermas.valor',
                             'compras.valor', 'compras.unidades', 'mermas.unidades',
                             'fondo', 'dias_cerrados']],
      ['/api/dia', jor, ['ventas.por_moneda.CUP', 'ventas.por_moneda.USD', 'dia']],
    ]) {
      const faltan = campos.filter(c => !hay(obj, c));
      comp('los datos de ' + donde + ' se llaman como la pantalla cree',
        faltan.length === 0, 'no vienen: ' + faltan.join(', '));
    }

    // La lista de arriba caza que el SERVIDOR deje de mandar algo. Lo del 14 de
    // agosto fue al revés: la PANTALLA se inventó un nombre (pasó a leer 'caja'
    // cuando el servidor manda 'gaveta') y ninguna lista fija se habría enterado.
    // Así que se hace también al contrario: se sacan de app.js los nombres con
    // los que lee estas respuestas y se comprueba que el servidor los manda.
    const claves = new Set();
    (function recoger(x) {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) return x.forEach(recoger);
      for (const k of Object.keys(x)) { claves.add(k); recoger(x[k]); }
    })({ neg, fon, res, jor });

    const app = fs.readFileSync(path.join(raiz, 'public', 'app.js'), 'utf8');
    // Solo los portadores que sabemos de dónde vienen: 'p' es cada sitio de
    // /api/negocio, y NEGOCIO/FONDO/neg son las respuestas enteras. Lo que se
    // lea de otra cosa no se mira aquí, para no cazar lo que no es.
    const sospechas = new Map();
    for (const [patron, de] of [
      [/\bp\.(\w+)\.(?:CUP|USD)\b/g, 'un sitio de /api/negocio'],
      [/\bNEGOCIO\.total\.(\w+)/g, 'el total de /api/negocio'],
      [/\bn\.total\.(\w+)/g, 'el total de /api/negocio'],
      [/\bneg\.(\w+)/g, '/api/negocio'],
      [/\bFONDO\.(\w+)/g, '/api/fondo'],
    ]) {
      let m;
      while ((m = patron.exec(app))) if (!claves.has(m[1])) sospechas.set(m[1], de);
    }
    comp('la pantalla no lee ningún nombre que el servidor no mande',
      sospechas.size === 0,
      [...sospechas].map(([k, d]) => '«' + k + '» leído de ' + d).join(' ; '));

    console.log('\n=== Y se puede seguir trabajando encima ===');
    const catalogo = (await pedir('/api/productos')).cuerpo;
    const unProducto = (Array.isArray(catalogo) ? catalogo : catalogo.productos || [])[0] || {};
    const venta = await post('/api/ventas', { sitio_id: pun, moneda: 'CUP',
      lineas: [{ producto_id: unProducto.id, cantidad: 1 }] });
    comp('se vende en la caja', venta.status === 200, JSON.stringify(venta.cuerpo).slice(0, 160));
    const apunte = await post('/api/fondo', { tipo: 'ingreso', concepto: 'Prueba',
      importe: 100, moneda: 'CUP', sitio_id: pun });
    comp('se apunta dinero en el fondo', apunte.status === 200,
      JSON.stringify(apunte.cuerpo).slice(0, 160));
    const traspaso = await post('/api/fondo/traspaso', { origen_id: pun, destino_id: alm,
      importe: 50, moneda: 'CUP' });
    comp('se traspasa entre gavetas', traspaso.status === 200,
      JSON.stringify(traspaso.cuerpo).slice(0, 160));

  } catch (e) {
    mal++;
    console.log('\n  MAL  el banco se rompió: ' + e.message);
  } finally {
    cerrarTodo();
    try { fs.rmSync(patio, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n' + (mal ? 'HAY ' + mal + ' FALLO(S)' : 'TODO BIEN') +
              ': ' + (ok + mal) + ' comprobaciones');
  process.exit(mal ? 1 : 0);
})();
