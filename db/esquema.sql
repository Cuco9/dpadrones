-- D´Padrones — esquema de la base de datos
-- Las reglas que hay detrás están en DECISIONES.md. Las dos que mandan aquí:
--   1. El stock NO se guarda: se suma desde la tabla movimientos.
--   2. Los movimientos son inmutables. Anular = meter el movimiento contrario.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─── AJUSTES Y SINCRONIZACIÓN ─────────────────────────────────
-- Cada copia de la aplicación tiene su propio identificador de instalación.
-- Sin él no se puede saber de dónde viene un paquete de datos.
CREATE TABLE IF NOT EXISTS ajustes (
  clave        TEXT PRIMARY KEY,
  valor        TEXT
);

-- Hasta dónde se sincronizó con cada interlocutor. Guardar la marca por
-- separado permite mandar solo lo nuevo, y volver a mandarlo todo si hace falta.
CREATE TABLE IF NOT EXISTS sync_marcas (
  par          TEXT PRIMARY KEY,   -- instalación o URL del otro lado
  ultima       TEXT,               -- marca de agua: hasta aquí ya se mandó
  ultimo_uso   TEXT,
  resultado    TEXT
);

-- ─── SITIOS ───────────────────────────────────────────────────
-- El almacén principal y los puntos de venta son la misma cosa con distinto
-- papel: los dos tienen inventario, ventas y contabilidad. 'padre_id' dice de
-- qué almacén se surte un punto; si es NULL, el sitio es independiente.
CREATE TABLE IF NOT EXISTS sitios (
  id           TEXT PRIMARY KEY,
  nombre       TEXT NOT NULL,
  tipo         TEXT NOT NULL CHECK (tipo IN ('almacen','punto')),
  padre_id     TEXT REFERENCES sitios(id),
  activo       INTEGER NOT NULL DEFAULT 1,
  creado_en    TEXT NOT NULL,
  actualizado  TEXT NOT NULL
);

-- ─── APARATOS ─────────────────────────────────────────────────
-- Cada teléfono o tableta que usa la app. El id del aparato va en cada
-- movimiento: sin él no se puede saber quién apuntó qué cuando se juntan
-- varios aparatos de un mismo punto.
CREATE TABLE IF NOT EXISTS aparatos (
  id           TEXT PRIMARY KEY,
  nombre       TEXT NOT NULL,
  sitio_id     TEXT NOT NULL REFERENCES sitios(id),
  ultima_sync  TEXT,
  creado_en    TEXT NOT NULL
);

-- ─── PERSONAS Y PERMISOS ──────────────────────────────────────
-- El administrador crea los cargos y marca qué puede hacer cada uno.
-- 'permisos' es una lista separada por comas; se amplía sin migrar nada.
CREATE TABLE IF NOT EXISTS cargos (
  id           TEXT PRIMARY KEY,
  nombre       TEXT NOT NULL,
  permisos     TEXT NOT NULL DEFAULT '',
  es_admin     INTEGER NOT NULL DEFAULT 0,
  creado_en    TEXT NOT NULL,
  actualizado  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS personas (
  id           TEXT PRIMARY KEY,
  nombre       TEXT NOT NULL,
  usuario      TEXT UNIQUE,
  pin_hash     TEXT,
  cargo_id     TEXT REFERENCES cargos(id),
  sitio_id     TEXT REFERENCES sitios(id),
  activo       INTEGER NOT NULL DEFAULT 1,
  creado_en    TEXT NOT NULL,
  actualizado  TEXT NOT NULL
);

-- Sesiones abiertas. Un token por aparato; se puede cerrar desde el servidor
-- sin tocar la contraseña de nadie.
CREATE TABLE IF NOT EXISTS sesiones (
  token        TEXT PRIMARY KEY,
  persona_id   TEXT NOT NULL REFERENCES personas(id),
  aparato      TEXT,
  creado_en    TEXT NOT NULL,
  ultimo_uso   TEXT
);

-- ─── CATÁLOGO ─────────────────────────────────────────────────
-- Dueño: el administrador. Viaja del principal a los puntos, nunca al revés.
-- 'costo' es el último costo conocido; 'costo_repo' lo que cuesta reponerlo hoy
-- (de La Inventería: la comisión del vendedor sale del margen a costo de
-- reposición, no de la subida de precios, que no es ganancia repartible).
-- 'codigo' es el que genera la app (QS-0001), correlativo y legible: se escribe
-- en el producto y se teclea en la caja. 'codigo_barra' es el del fabricante,
-- cuando el producto trae uno impreso; se puede escanear igual.
CREATE TABLE IF NOT EXISTS productos (
  id           TEXT PRIMARY KEY,
  codigo       TEXT UNIQUE,
  codigo_barra TEXT,
  nombre       TEXT NOT NULL,
  categoria    TEXT NOT NULL DEFAULT '',
  um           TEXT NOT NULL DEFAULT 'Unidad',
  costo        REAL NOT NULL DEFAULT 0,
  costo_repo   REAL NOT NULL DEFAULT 0,
  -- El precio se pone UNA vez, en la moneda que se quiera. El otro lo calcula
  -- la app con el valor del dolar que fije el administrador (ajustes.tasa_usd).
  precio       REAL NOT NULL DEFAULT 0,
  precio_moneda TEXT NOT NULL DEFAULT 'CUP' CHECK (precio_moneda IN ('CUP','USD')),
  comision     REAL NOT NULL DEFAULT 0,   -- lo que gana el vendedor por unidad
  comision_pct INTEGER NOT NULL DEFAULT 0,-- 1 = la comisión es un % del precio
  stock_min    REAL NOT NULL DEFAULT 0,
  -- La foto va aquí dentro, en base64 y ya encogida por el aparato. Guardarla
  -- como archivo aparte obligaría a sincronizar dos cosas y a que una pudiera
  -- llegar sin la otra; así viaja pegada al producto, como un dato más.
  foto         TEXT,
  activo       INTEGER NOT NULL DEFAULT 1,
  creado_en    TEXT NOT NULL,
  actualizado  TEXT NOT NULL,
  borrado_en   TEXT
);
CREATE INDEX IF NOT EXISTS idx_productos_codigo ON productos(codigo);
CREATE INDEX IF NOT EXISTS idx_productos_barra ON productos(codigo_barra);
CREATE INDEX IF NOT EXISTS idx_productos_actualizado ON productos(actualizado);

-- Excepciones de precio por sitio. Si no hay fila, rige productos.precio.
CREATE TABLE IF NOT EXISTS precios_sitio (
  producto_id  TEXT NOT NULL REFERENCES productos(id),
  sitio_id     TEXT NOT NULL REFERENCES sitios(id),
  precio       REAL NOT NULL,   -- en la misma moneda que el producto
  actualizado  TEXT NOT NULL,
  PRIMARY KEY (producto_id, sitio_id)
);

-- ─── MOVIMIENTOS: EL CORAZÓN ──────────────────────────────────
-- Todo lo que mueve mercancía es una fila aquí, y estas filas NO SE TOCAN.
-- El stock de un producto en un sitio = SUM(cantidad) de sus movimientos.
--   cantidad > 0  entra    (compra, recepción de traslado, devolución, ajuste +)
--   cantidad < 0  sale     (venta, merma, salida de traslado, ajuste −)
-- 'anula_a' apunta al movimiento que corrige: así una venta anulada deja las
-- dos filas a la vista en vez de desaparecer del historial.
CREATE TABLE IF NOT EXISTS movimientos (
  id           TEXT PRIMARY KEY,          -- uuid generado en el aparato
  tipo         TEXT NOT NULL CHECK (tipo IN
                 ('compra','venta','merma','traslado_salida','traslado_entrada',
                  'ajuste','devolucion')),
  sitio_id     TEXT NOT NULL REFERENCES sitios(id),
  aparato_id   TEXT,
  persona_id   TEXT,
  producto_id  TEXT NOT NULL REFERENCES productos(id),
  cantidad     REAL NOT NULL,
  costo_unit   REAL NOT NULL DEFAULT 0,
  precio_unit  REAL NOT NULL DEFAULT 0,
  ref_tipo     TEXT,                      -- 'venta','traslado','inversion'...
  ref_id       TEXT,                      -- id del documento que lo origina
  anula_a      TEXT REFERENCES movimientos(id),
  motivo       TEXT,
  obs          TEXT,
  fecha        TEXT NOT NULL,             -- día contable AAAA-MM-DD
  ts           INTEGER NOT NULL,          -- momento exacto
  creado_en    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mov_sitio_prod ON movimientos(sitio_id, producto_id);
CREATE INDEX IF NOT EXISTS idx_mov_fecha ON movimientos(sitio_id, fecha);
CREATE INDEX IF NOT EXISTS idx_mov_ref ON movimientos(ref_tipo, ref_id);
CREATE INDEX IF NOT EXISTS idx_mov_creado ON movimientos(creado_en);
-- Para poder preguntar rápido «¿a este movimiento ya le entró el contrario?».
-- Mirar solo 'anula_a IS NULL' no vale: el ANULADO también lo tiene vacío, y
-- quien lleva el dato de que se anuló es el movimiento contrario.
CREATE INDEX IF NOT EXISTS idx_mov_anula ON movimientos(anula_a);

-- Stock actual de cada producto en cada sitio. Es una VISTA: no se guarda,
-- se calcula. Si algún día hace falta por velocidad, se cachea, pero la
-- verdad sigue estando en movimientos.
CREATE VIEW IF NOT EXISTS stock AS
  SELECT sitio_id, producto_id, SUM(cantidad) AS cantidad
  FROM movimientos GROUP BY sitio_id, producto_id;

-- ─── VENTAS ───────────────────────────────────────────────────
-- Cabecera. Las líneas son movimientos con ref_tipo='venta'.
CREATE TABLE IF NOT EXISTS ventas (
  id           TEXT PRIMARY KEY,
  sitio_id     TEXT NOT NULL REFERENCES sitios(id),
  aparato_id   TEXT,
  persona_id   TEXT,
  -- El total va en la MONEDA de la venta: es el efectivo que entró. El costo y
  -- la comisión van en la moneda del NEGOCIO (ajustes.moneda_base), que es otra
  -- cosa: la medida de cómo va el negocio, y esa tiene que ser una sola.
  moneda       TEXT NOT NULL DEFAULT 'CUP' CHECK (moneda IN ('CUP','USD')),
  -- El valor del dólar del día de la venta, congelado aquí. Sin él, cambiar la
  -- tasa en Ajustes movería las ganancias de todos los meses anteriores, y una
  -- jornada cerrada dejaría de significar nada (DECISIONES.md #21).
  tasa         REAL NOT NULL DEFAULT 0,
  total        REAL NOT NULL DEFAULT 0,
  costo_total  REAL NOT NULL DEFAULT 0,
  comision     REAL NOT NULL DEFAULT 0,
  forma_pago   TEXT NOT NULL DEFAULT 'efectivo',
  cliente      TEXT,
  anulada_en   TEXT,
  fecha        TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  creado_en    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ventas_fecha ON ventas(sitio_id, fecha);

-- ─── DÍAS ─────────────────────────────────────────────────────
-- Un día cerrado no se toca (DECISIONES.md #5). El inventario inicial del día
-- siguiente NO se copia: se calcula sumando movimientos hasta el corte.
CREATE TABLE IF NOT EXISTS dias (
  sitio_id     TEXT NOT NULL REFERENCES sitios(id),
  fecha        TEXT NOT NULL,
  cerrado_en   TEXT,
  cerrado_por  TEXT,
  efectivo     REAL NOT NULL DEFAULT 0,   -- contado en CUP
  efectivo_usd REAL NOT NULL DEFAULT 0,   -- contado en USD
  transfer     REAL NOT NULL DEFAULT 0,
  obs          TEXT,
  PRIMARY KEY (sitio_id, fecha)
);

-- Conteo físico del cierre: sirve para DETECTAR descuadres, no para calcular
-- las ventas. La diferencia con el stock teórico queda registrada como sobra
-- o falta, y si se ajusta se hace con un movimiento de tipo 'ajuste'.
CREATE TABLE IF NOT EXISTS conteos (
  id           TEXT PRIMARY KEY,
  sitio_id     TEXT NOT NULL REFERENCES sitios(id),
  fecha        TEXT NOT NULL,
  producto_id  TEXT NOT NULL REFERENCES productos(id),
  contado      REAL NOT NULL,
  teorico      REAL NOT NULL,
  creado_en    TEXT NOT NULL
);

-- ─── LO HECHO EN LA PIEL DE OTRO ──────────────────────────────
-- Cuando el administrador se hace pasar por un trabajador (DECISIONES.md #35),
-- todo lo que apunta queda a SU nombre: una venta es una venta y el registro no
-- puede mentir sobre quién la hizo. Pero hace falta poder contestar «¿por qué el
-- jefe apuntó esto a las once de la noche?», y la respuesta es «estaba probando
-- los permisos de Daniela». Eso se guarda aquí.
--
-- Solo se apunta lo que ESCRIBE: mirar pantallas en la piel de otro no cambia
-- nada y llenaría la tabla de ruido.
--
-- No viaja en la sincronización a propósito: es el diario de este dispositivo, no
-- un dato del negocio. Mandarlo a los demás no le sirve a nadie y engordaría cada
-- paquete.
CREATE TABLE IF NOT EXISTS actuaciones (
  id           TEXT PRIMARY KEY,
  persona_id   TEXT NOT NULL,     -- quien firma de verdad
  como_id      TEXT NOT NULL,     -- en la piel de quién estaba
  metodo       TEXT NOT NULL,
  ruta         TEXT NOT NULL,
  creado_en    TEXT NOT NULL
);

-- ─── QUIÉNES TRABAJARON ESE DÍA ───────────────────────────────
-- La comisión del día se reparte a partes iguales entre los que estuvieron, y no
-- se le atribuye a quien marcó la venta (DECISIONES.md #32). En el mostrador
-- cobra quien tiene el teléfono en la mano, que no es quien más ha trabajado.
--
-- Dos detalles que no son de adorno:
--
--   'presente' es 0 o 1 y la fila NO se borra al desmarcar a alguien. Una fila
--   que desaparece no viaja en la sincronización, así que al juntar dos aparatos
--   volvería del otro lado y esa persona reaparecería en el reparto. Misma
--   lápida que 'cargos.borrado_en' y 'web_articulos'.
--
--   'actualizado' es la columna por la que el cambio viaja (DECISIONES.md #11).
--   Sin ella, marcar y desmarcar se quedaría en el aparato donde se hizo.
CREATE TABLE IF NOT EXISTS dia_personas (
  sitio_id     TEXT NOT NULL REFERENCES sitios(id),
  fecha        TEXT NOT NULL,
  persona_id   TEXT NOT NULL REFERENCES personas(id),
  presente     INTEGER NOT NULL DEFAULT 1,
  actualizado  TEXT NOT NULL,
  PRIMARY KEY (sitio_id, fecha, persona_id)
);

-- ─── TRASLADOS ────────────────────────────────────────────────
-- Dos mitades con dueños distintos: el almacén registra la salida y el punto
-- confirma la recepción. Nadie corrige al otro; lo que no cuadra queda a la
-- vista como faltante en tránsito.
CREATE TABLE IF NOT EXISTS traslados (
  id           TEXT PRIMARY KEY,
  origen_id    TEXT NOT NULL REFERENCES sitios(id),
  destino_id   TEXT NOT NULL REFERENCES sitios(id),
  estado       TEXT NOT NULL DEFAULT 'en_transito'
                 CHECK (estado IN ('en_transito','recibido','recibido_parcial','cancelado')),
  despachado_en TEXT NOT NULL,
  recibido_en  TEXT,
  obs          TEXT
);

-- ─── DINERO ───────────────────────────────────────────────────
-- El fondo: entra lo de ventas y servicios, sale lo de retiros e inversiones.
-- Toda salida obliga a declarar de qué tipo es.
-- Dos saldos separados, uno por moneda. NO se convierten: en Cuba juntarlos
-- daria un numero que no significa nada.
CREATE TABLE IF NOT EXISTS fondo (
  id           TEXT PRIMARY KEY,
  tipo         TEXT NOT NULL CHECK (tipo IN ('ingreso','retiro','inversion','gasto')),
  subtipo      TEXT,                      -- 'servicio','productos','salario'...
  moneda       TEXT NOT NULL DEFAULT 'CUP' CHECK (moneda IN ('CUP','USD')),
  importe      REAL NOT NULL,
  sitio_id     TEXT REFERENCES sitios(id),
  persona_id   TEXT,
  concepto     TEXT NOT NULL DEFAULT '',
  ref_tipo     TEXT,
  ref_id       TEXT,
  fecha        TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  creado_en    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fondo_fecha ON fondo(fecha);

-- ─── INVERSIONES ──────────────────────────────────────────────
-- Una inversión es una compra de mercancía: la lista de lo que se compró, a qué
-- precio cada cosa, y a qué almacén o punto va cada unidad. El importe NO se
-- escribe: sale de sumar las líneas.
--
-- Cada inversión es independiente y lleva su propia cuenta de cuánto se ha
-- recuperado, que se saca de las ventas de ESOS productos. No guarda ninguna
-- cifra de recuperación: se calcula, igual que el stock (DECISIONES.md #1).
--
-- Nace en 'borrador', que es cuando se puede tocar. Al REGISTRARLA se crean los
-- movimientos de entrada en cada sitio y el apunte del fondo, y a partir de ahí
-- las líneas ya no cambian: documentan lo que se compró y a qué costo.
CREATE TABLE IF NOT EXISTS inversiones (
  id           TEXT PRIMARY KEY,
  numero       TEXT,                        -- INV-0001, correlativo y legible
  nombre       TEXT NOT NULL,
  proveedor    TEXT,
  nota         TEXT,
  -- De qué gaveta salió el dinero. Vacío = del negocio, que es lo normal. Si se
  -- cogió de la gaveta de un punto hay que decirlo, o esa gaveta deja de cuadrar
  -- con lo que hay dentro de verdad.
  sitio_id     TEXT REFERENCES sitios(id),
  moneda       TEXT NOT NULL DEFAULT 'CUP' CHECK (moneda IN ('CUP','USD')),
  estado       TEXT NOT NULL DEFAULT 'borrador'
                 CHECK (estado IN ('borrador','registrada','cancelada')),
  fecha        TEXT NOT NULL,
  registrada_en TEXT,
  cancelada_en TEXT,
  creado_en    TEXT NOT NULL,
  actualizado  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inversiones_actualizado ON inversiones(actualizado);

-- Lo que se compró. 'costo_unit' va en la moneda de la inversión.
--
-- Una línea puede NO llevar producto: entonces es dinero con un concepto
-- ('descripcion'), como el transporte, un ayudante o la comida de la obra. No
-- entra en el inventario porque no es mercancía, pero sí sale del fondo y sí
-- cuenta en el importe. Sin esto, «saco 50 para el trabajo» no cabía en ningún
-- sitio, y eso empujaba a apuntarlo como gasto suelto, que es justo lo que se
-- quería dejar de hacer.
CREATE TABLE IF NOT EXISTS inversion_lineas (
  id           TEXT PRIMARY KEY,
  inversion_id TEXT NOT NULL REFERENCES inversiones(id),
  producto_id  TEXT REFERENCES productos(id),
  descripcion  TEXT,                        -- para lo que no es mercancía
  cantidad     REAL NOT NULL,
  costo_unit   REAL NOT NULL DEFAULT 0,
  orden        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_inv_lineas ON inversion_lineas(inversion_id);

-- A qué sitio va cada parte de una línea. Lo que no se reparta se queda en el
-- almacén principal: la mercancía existe aunque nadie diga dónde ponerla.
-- 'inversion_id' se repite aquí a propósito, aunque se podría sacar de la
-- línea: al juntar dos aparatos hay que poder rehacer el reparto entero de una
-- inversión de un golpe, y con un salto más de tabla eso se vuelve frágil.
CREATE TABLE IF NOT EXISTS inversion_reparto (
  linea_id     TEXT NOT NULL REFERENCES inversion_lineas(id),
  inversion_id TEXT NOT NULL REFERENCES inversiones(id),
  sitio_id     TEXT NOT NULL REFERENCES sitios(id),
  cantidad     REAL NOT NULL,
  PRIMARY KEY (linea_id, sitio_id)
);
CREATE INDEX IF NOT EXISTS idx_inv_reparto ON inversion_reparto(inversion_id);
