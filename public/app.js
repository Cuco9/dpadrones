// D´Padrones — aplicación
// Fase 1: el catálogo. Las reglas de fondo están en DECISIONES.md.
// El catálogo entero se carga en el dispositivo y se filtra aquí: así el buscador
// es instantáneo y seguirá funcionando cuando la app trabaje sin internet.

let PRODUCTOS = [];
let SITIOS = [];
let CLIENTES = [];        // los que se han dado de alta, para poder fiarles (#43)
let editando = null;      // id del producto abierto en la ficha, o null si es nuevo
// La foto de la ficha abierta, ya encogida. Tres valores y los tres significan algo
// distinto: unos datos = foto nueva; null = quitarla; undefined = no se ha tocado,
// que el servidor deje la que haya. Sin ese tercer estado, editarle el precio a un
// producto le borraría la foto, porque el catálogo ya no la trae para devolverla.
let fotoActual = null;
let FICHA_PRODUCTO = null;   // el producto que se está editando, para su foto
// Si la ficha abierta va a CREAR un producto —uno en blanco o una copia—. No es lo
// mismo que «editando === null» a la hora de leerlo desde el desplegable del local,
// que se toca con la ficha ya abierta.
let fichaNaciendo = false;

let YO = null;            // { persona, cargo, permisos }
let PERMISOS_POSIBLES = [];

const $ = id => document.getElementById(id);
const token = () => localStorage.getItem('dp_token') || '';
// El dispositivo esconde lo que no toca, pero quien de verdad manda es el servidor:
// esto es comodidad, no seguridad (DECISIONES.md y el propio server.js).
function puedo(...lista) {
  const p = (YO && YO.permisos) || [];
  return p.includes('*') || lista.some(x => p.includes(x));
}
let TASA = 0;                       // cuántos CUP vale 1 USD
// En qué moneda se MIDE el negocio: los costos, el valor del almacén, las
// ganancias y las comisiones. No es en qué se cobra —eso se elige en cada
// venta—, es en qué se piensa. Se cambia en Ajustes.
let MONEDA_BASE = 'CUP';
// Si la caja deja cobrar algo que el inventario dice que no está. Viene
// cerrado. Quien manda de verdad es el servidor; esto es para no dejar que
// alguien monte un carro entero y se lleve el golpe al final.
let VENDER_SIN_STOCK = false;

// Lo que queda de un producto contando lo que ya está en el carro.
function quedaEnCaja(id) {
  const enCarro = (CARRO.find(l => l.producto_id === id) || {}).cantidad || 0;
  return Number(STOCK[id] || 0) - enCarro;
}
let MONEDA = localStorage.getItem('dp_moneda') || 'CUP';   // en qué se cobra ahora

// El dinero SIEMPRE se escribe con su moneda al lado. Un número suelto en una
// tienda que cobra en dos monedas es una invitación a equivocarse.
const dinero = (n, m) => (m === 'USD'
  ? (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('es-CU',
      { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' USD'
  : Math.round(Number(n) || 0).toLocaleString('es-CU') + ' CUP');
const pesos = n => dinero(n, 'CUP');
// Para todo lo que es medida del negocio y no efectivo: costos, valor del
// almacén, ganancias y comisiones.
const enBase = n => dinero(n, MONEDA_BASE);
const otraMoneda = () => (MONEDA_BASE === 'USD' ? 'CUP' : 'USD');
// Lo mismo, con la otra moneda al lado entre paréntesis. Es SOLO para mirar:
// las dos cifras son el mismo dinero contado de dos formas, y no se suman
// jamás (DECISIONES.md #21). Se usa en los totales, donde saber de cuánto se
// habla importa; en una lista larga cansaría la vista.
const conRef = n => {
  const o = convertir(Number(n) || 0, MONEDA_BASE, otraMoneda());
  return enBase(n) + (o === null ? '' : ' (' + dinero(o, otraMoneda()) + ')');
};

// Pasa un importe de una moneda a la otra con la tasa. Sin tasa no se inventa.
function convertir(n, de, a) {
  if (de === a) return n;
  if (!TASA) return null;
  return de === 'USD' ? n * TASA : n / TASA;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('ver');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('ver'), 2600);
}

async function api(ruta, opciones) {
  const o = Object.assign({}, opciones || {});
  o.headers = Object.assign({ 'Content-Type': 'application/json' },
    token() ? { Authorization: 'Bearer ' + token() } : {}, o.headers || {});
  let r;
  try {
    r = await fetch(ruta, o);
  } catch (e) {
    // Sin servidor, el navegador solo dice "Failed to fetch". Eso se lee como
    // "mi contraseña está mal" y manda a la persona a buscar donde no es.
    // LO QUE SE LE DICE A LA PERSONA, no lo que le pasa al programa. Aquí ponía
    // cómo arrancar el servidor desde una consola, y eso lo veía el cliente en su
    // teléfono: además de no servirle de nada —en un teléfono no hay consola—,
    // enseña por dentro un trabajo que se le entrega terminado.
    //
    // El mensaje dice qué pasa y qué hacer, en el idioma de quien lo lee.
    throw new Error('Sin conexión.\n\n' +
      'Comprueba que el teléfono tiene datos o wifi y vuelve a intentarlo.');
  }
  const cuerpo = await r.json().catch(() => ({}));
  if (r.status === 401 && YO) { cerrarSesionLocal(); throw new Error('La sesión se cerró'); }
  if (!r.ok) {
    // El cuerpo del error viaja PEGADO al Error, y no solo su texto. Cuando una
    // puerta se cierra por falta de permiso, el servidor dice cuál falta y de qué
    // cargo, y con eso se le puede ofrecer al administrador dárselo en el momento
    // (DECISIONES.md #35). Perdiendo el cuerpo, quedaría solo la frase.
    const e = new Error(cuerpo.error || ('no se pudo completar (' + r.status + ')'));
    e.datos = cuerpo;
    e.status = r.status;
    // Si la puerta se cerró por un permiso, se apunta para poder ofrecerlo en la
    // tira de arriba. Aquí y no en cada catch: hay más de cien llamadas.
    if (r.status === 403) { try { registrarFalta(cuerpo); } catch (x) {} }
    throw e;
  }
  return cuerpo;
}

// ─── Navegación ───────────────────────────────────────────────
// La pantalla en la que estabas se recuerda: refrescar no puede mandarte de
// vuelta al principio a mitad de una tarea.
//
// Esto corre ANTES de pedirle nada al servidor. Si se dejara para después de
// cargar los datos, al quitar la capa de entrar se vería primero la caja -que
// es la que viene marcada en el HTML- y un instante despues el salto a la
// pantalla buena. Se notaba.
function ponerPantalla(pantalla) {
  const sec = document.getElementById('p-' + pantalla);
  const btn = document.querySelector('nav button[data-p="' + pantalla + '"]');
  if (!sec || !btn) return false;
  if (!sec.classList.contains('activa')) {
    document.querySelectorAll('.pantalla').forEach(p => p.classList.remove('activa'));
    sec.classList.add('activa');
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('activo'));
  btn.classList.add('activo');
  return true;
}
(function alAbrir() {
  const p = localStorage.getItem('dp_pantalla');
  if (p) ponerPantalla(p);       // el <body> aún está tapado: no se ve nada moverse
})();

function irA(pantalla, btn) {
  localStorage.setItem('dp_pantalla', pantalla);
  ponerPantalla(pantalla);
  // Las comisiones ya NO se cargan aquí: se fueron a Dinero, que es donde se paga
  // (#37). Una petición menos de las doce que dispara esta pantalla.
  if (pantalla === 'ajustes') { volverAjustes(); cargarEstado(); cargarPersonal(); cargarSync(); cargarTasa(); pintarMarca(); cargarSalvas(); cargarBorrado(); mirarVersiones(); }
  if (pantalla === 'ventas') cargarDia();
  if (pantalla === 'almacen') cargarAlmacen();
  // Productos no pide nada al servidor: pinta el catálogo que ya está cargado. Se
  // repinta al entrar porque puede haber cambiado desde la última vez —un producto
  // creado en otra pantalla, un traslado recibido, un cambio de local—.
  if (pantalla === 'productos') renderLista();
  if (pantalla === 'dinero') cargarFondo();
  if (pantalla === 'caja') { renderResultados(); setTimeout(() => $('caja-busq').focus(), 80); }
}

// ─── La tecla «atrás» del teléfono ────────────────────────────
// Sin esto, UN solo toque en «atrás» cierra la aplicación de golpe: instalada en
// el teléfono no hay página anterior a la que volver, así que el sistema la
// saca. Y pasa a mitad de una venta, con el carro a medias.
//
// El truco es tener SIEMPRE una entrada de historia de sobra puesta. Cuando
// «atrás» se la come, el sistema no saca a nadie —había a dónde volver—, aquí
// se decide qué hacer y se vuelve a poner la entrada.
//
//   1. Si hay una ventana abierta, «atrás» cierra esa ventana y nada más.
//   2. Si no hay ninguna, el primer toque avisa y solo el segundo, dentro de
//      dos segundos, sale de verdad.
let atrasArmado = 0;
function ponerRedDeAtras() {
  try { history.pushState({ dp: 1 }, ''); } catch (e) {}
}

// La ventana de encima. Todos los velos comparten z-index, así que la que pinta
// encima es la ÚLTIMA del HTML, no la última que se abrió; y son la misma cosa
// mientras las ventanas se declaren en el orden en que se apilan.
function ventanaDeEncima() {
  const abiertas = document.querySelectorAll('.velo.abierto');
  return abiertas.length ? abiertas[abiertas.length - 1] : null;
}

// Se cierra LLAMANDO A SU FUNCIÓN, nunca quitándole la clase a mano: el escáner
// tiene que apagar la cámara —si no, se queda encendida y comiéndose la
// batería—, y la ficha, el fondo o la inversión tienen que soltar lo que
// estaban editando. Quitar la clase esconde la ventana y deja el trabajo a
// medias por dentro.
//
// El nombre de esa función se lee del propio HTML: cada velo ya lo lleva en su
// onclick, para cerrarse al tocar fuera. Así una ventana nueva funciona sola,
// sin que nadie tenga que acordarse de apuntarla en ninguna lista de aquí.
function cerrarVentana(velo) {
  const nombre = (String(velo.getAttribute('onclick') || '')
    .match(/(cerrar[A-Za-z]+)\(\)/) || [])[1];
  if (nombre && typeof window[nombre] === 'function') { window[nombre](); return; }
  velo.classList.remove('abierto');
}

// LA RED HAY QUE PONERLA DESPUÉS DE QUE LA PERSONA TOQUE LA PANTALLA, y esto es
// lo que faltaba: puesta al cargar, no servía de nada.
//
// Chrome se defiende de las páginas que secuestran el botón «atrás» y SE SALTA
// las entradas de historial creadas sin que nadie haya tocado nada. La nuestra se
// creaba al arrancar la aplicación, así que era justo de las que se salta: el
// primer toque en «atrás» pasaba por encima de ella y cerraba la aplicación, sin
// llegar a salir el aviso. El dueño lo dijo tal cual el 3 de septiembre de 2026:
// «cuando doy atrás no sale cartel de dos toques, sino que sale directamente».
//
// Con un toque cualquiera —abrir la caja, escribir, pulsar un botón— la entrada
// ya vale, y a partir de ahí las que se ponen al cerrar una ventana también, que
// esas nacen de un «atrás» y por tanto de un gesto.
//
// Se pone una sola vez y los escuchas se quitan solos: dejarlos puestos sería
// empujar una entrada nueva en cada toque de la pantalla, y entonces harían falta
// cuarenta «atrás» para salir.
let redPuesta = false;
function ponerRedAlPrimerToque() {
  if (redPuesta) return;
  redPuesta = true;
  ponerRedDeAtras();
  for (const ev of ['pointerdown', 'keydown']) window.removeEventListener(ev, ponerRedAlPrimerToque);
}
for (const ev of ['pointerdown', 'keydown'])
  window.addEventListener(ev, ponerRedAlPrimerToque, { passive: true });

window.addEventListener('popstate', () => {
  // Si «atrás» llega antes de que nadie haya tocado la pantalla, la red no está
  // puesta; se pone ahora, que este popstate ya es un gesto de la persona.
  redPuesta = true;
  const velo = ventanaDeEncima();
  if (velo) { cerrarVentana(velo); ponerRedDeAtras(); return; }
  if (Date.now() - atrasArmado < 2000) {
    // Segundo toque: se sale de verdad. NO se vuelve a poner la red, y se pide
    // ir atrás otra vez, que es lo que cierra la aplicación instalada.
    setTimeout(() => { try { history.back(); } catch (e) {} }, 0);
    return;
  }
  atrasArmado = Date.now();
  toast('Toca «atrás» otra vez para salir');
  ponerRedDeAtras();
});

// ─── Lo que se carga al arrancar ──────────────────────────────
// El catálogo entero, los sitios y las existencias. Ya no hay pantalla de
// productos: el catálogo se ve y se edita desde el Almacén, que es donde de
// verdad se mira. Esto sigue siendo el cargador de todo lo demás.
async function cargarCatalogo() {
  try {
    const d = await api('/api/productos');
    PRODUCTOS = d.productos || [];
    SITIOS = d.sitios || [];
    rellenarCategorias();
    pintarSelectorSitio();
    // Los clientes NO se esperan aquí: solo hacen falta al cobrar, y al entrar
    // ponían un viaje más en la fila. Las existencias tampoco: quien llama a esto
    // al arrancar las pide a la vez, y quien lo llama después de cambiar algo las
    // vuelve a pedir por su cuenta.
    cargarClientes();
    await cargarStock();
    renderCarro();
    renderLista();
    // La rejilla de la caja se dibuja AQUI. Antes solo se rehacia al escribir en
    // el buscador, asi que al entrar la pantalla estaba vacia.
    renderResultados();
  } catch (e) {
    console.error('No se pudo cargar el catálogo:', e.message);
  }
}

// Lo que se está diciendo, escrito debajo mientras se escribe: «una caja trae 24
// unidades» leído en voz alta es lo que evita teclear 24 donde iban 240.
// El plural, para no escribir «24 unidad» ni «en cajas» cuando el bulto es un
// saco. Vocal + s, consonante + es: vale para unidad→unidades, saco→sacos,
// metro→metros y caja→cajas, que es todo lo que se teclea aquí.
const enPlural = p => {
  const t = String(p || '').trim();
  if (!t) return t;
  return /[aeiouáéíóú]$/i.test(t) ? t + 's' : t + 'es';
};

// Elegir en la lista, o escribirlo. La casilla de texto es la que manda —es la
// que se guarda—; el desplegable solo la rellena. Así el resto del código sigue
// leyendo lo de siempre y no se entera de que ahora hay una lista.
function alElegirUnidad() {
  const sel = $('f-um-sel'), caja = $('f-um');
  const otra = sel.value === '__otro';
  caja.style.display = otra ? '' : 'none';
  if (!otra) caja.value = sel.value;
  else if (['Unidad', 'Libra', 'Kilogramo', 'Metro', 'Litro', 'Galón', 'Rollo',
            'Juego', 'Par'].includes(caja.value)) caja.value = '';
  if (otra) setTimeout(() => caja.focus(), 60);
  pistaDelBulto();
}

function alElegirBulto() {
  const sel = $('f-caja-sel'), caja = $('f-nombrecaja');
  const otro = sel.value === '__otro';
  const hay = !!sel.value;
  $('f-caja-caja').style.display = hay ? 'block' : 'none';
  caja.style.display = otro ? '' : 'none';
  if (!hay) { caja.value = ''; $('f-porcaja').value = ''; }
  else if (!otro) caja.value = sel.value;
  else if (['Caja', 'Saco', 'Paquete', 'Bolsa', 'Bulto', 'Quintal', 'Docena',
            'Palet'].includes(caja.value)) caja.value = '';
  if (otro) setTimeout(() => caja.focus(), 60);
  pistaDelBulto();
}

// Poner los dos desplegables en lo que tenga el producto. Si lo suyo no está en
// la lista, se elige «otra cosa» y se enseña lo escrito.
function ponerListasDelProducto(p) {
  const um = (p && p.um) || 'Unidad';
  const sel = $('f-um-sel');
  $('f-um').value = um;
  sel.value = [...sel.options].some(o => o.value === um) ? um : '__otro';
  $('f-um').style.display = sel.value === '__otro' ? '' : 'none';

  const bulto = (p && p.nombre_caja) || '';
  const por = (p && p.unidades_por_caja) || 0;
  const selB = $('f-caja-sel');
  $('f-nombrecaja').value = bulto;
  $('f-porcaja').value = por > 0 ? por : '';
  selB.value = !por && !bulto ? ''
    : ([...selB.options].some(o => o.value === bulto) && bulto ? bulto : '__otro');
  $('f-caja-caja').style.display = selB.value ? 'block' : 'none';
  $('f-nombrecaja').style.display = selB.value === '__otro' ? '' : 'none';
  pistaDelBulto();
}

function pistaDelBulto() {
  const caja = $('f-bulto-pista');
  if (!caja) return;
  const por = parseFloat($('f-porcaja').value) || 0;
  const nombre = ($('f-nombrecaja').value.trim() || 'caja').toLowerCase();
  const um = ($('f-um').value.trim() || 'unidad').toLowerCase();
  // El rótulo del número dice la unidad: «Y trae dentro … Libras». Así no hay
  // que adivinar en qué se escribe esa cifra, que es lo que preguntó el dueño
  // —«al elegir saco no veo dónde poner que es libras o kilos»—.
  if ($('f-porcaja-lbl')) $('f-porcaja-lbl').textContent =
    'Y trae dentro (' + enPlural(um) + ')';
  // «Cada caja» y no «un caja» / «una caja»: así no hay que acertar el género de
  // una palabra que escribe el dueño y que puede ser cualquiera.
  const enBultos = $('f-caja-sel') && !!$('f-caja-sel').value;
  caja.innerHTML = !enBultos
    ? 'Se cuenta y se transfiere en <b>' + esc(enPlural(um)) + '</b>.'
    : (por > 0
      ? 'Cada <b>' + esc(nombre) + '</b> trae <b>' + por + ' ' +
        esc(por === 1 ? um : enPlural(um)) + '</b>. Al apuntar una entrada o una transferencia ' +
        'podrás escribir en ' + esc(enPlural(nombre)) + ', y la aplicación guarda ' +
        'las ' + esc(enPlural(um)) + '. <b>La existencia siempre se cuenta en ' +
        esc(enPlural(um)) + '.</b>'
      : 'Escribe cuántas <b>' + esc(enPlural(um)) + '</b> trae cada <b>' +
        esc(nombre) + '</b>.');
}

// ─── LEER UNA CANTIDAD EN BULTOS (DECISIONES.md #44) ─────────
// Por dentro todo son unidades. Esto solo traduce para leer: «240» en un estante
// que se cuenta por cajas de 24 se mira mejor como «10 cajas».
//
// Se calcula con el factor de HOY, y es lo correcto: es una forma de leer la
// existencia de ahora, no un dato guardado. Por eso cambiar «una caja trae 24»
// por «trae 12» no reescribe ningún movimiento — no hay nada que reescribir.
//
// Si no sale ni una caja entera no se dice nada: «0 cajas y 7» no ayuda a nadie.
function enBultos(p, unidades) {
  const por = Number(p && p.unidades_por_caja) || 0;
  const u = Math.abs(Number(unidades) || 0);
  if (por <= 0 || !u) return '';
  const cajas = Math.floor(u / por);
  if (!cajas) return '';
  const sueltas = Math.round((u - cajas * por) * 10000) / 10000;
  const nombre = (p.nombre_caja || 'caja').toLowerCase();
  return cajas + ' ' + (cajas === 1 || nombre.endsWith('s') ? nombre : nombre + 's') +
         (sueltas > 0.0001 ? ' y ' + sueltas : '');
}

// El nombre del bulto tal como se enseña en un DESPLEGABLE: «Caja (de 24)».
const rotuloBulto = p => {
  const nombre = (p && p.nombre_caja) || 'Caja';
  return nombre + (p && p.unidades_por_caja ? ' (de ' + p.unidades_por_caja + ')' : '');
};

// Y tal como se lee dentro de una FRASE: «3 cajas de 24». El rótulo del
// desplegable no vale aquí —«3 Caja (de 24)» no se lee— y son dos usos distintos
// de la misma palabra, así que son dos funciones.
const bultosEscritos = (p, cuantos) => {
  const nombre = ((p && p.nombre_caja) || 'caja').toLowerCase();
  const por = Number(p && p.unidades_por_caja) || 0;
  return cuantos + ' ' + (cuantos === 1 ? nombre : enPlural(nombre)) +
         (por ? ' de ' + por : '');
};

// Las categorías que existen, para Productos, para el desplegable de la caja y
// para la lista de sugerencias de la ficha. El del almacén se rellena aparte, al
// entrar en esa pantalla.
function rellenarCategorias() {
  // Las categorías salen de lo que se ve en cada pantalla (#45): un desplegable
  // con «Refrescos» dentro que al elegirlo deja la lista vacía no sirve para nada.
  //
  // Y por eso son DOS listas y no una: en el apartado de Productos también están
  // los que todavía no tienen local, y en la caja no. Con una sola lista, la caja
  // acabaría ofreciendo una categoría cuyos productos no se pueden vender.
  const cats = [...new Set(productosDelApartado().map(p => p.categoria).filter(Boolean))].sort();
  const catsCaja = [...new Set(productosAqui().map(p => p.categoria).filter(Boolean))].sort();
  const sel = $('f-cat');
  if (sel) { const antes = sel.value;
    sel.innerHTML = '<option value="">Todas las categorías</option>' +
      cats.map(c => `<option>${esc(c)}</option>`).join('');
    sel.value = antes; }
  $('lista-cats').innerHTML = cats.map(c => `<option>${esc(c)}</option>`).join('');
  const cj = $('caja-cat');
  if (cj) { const a = cj.value;
    cj.innerHTML = '<option value="">Todo</option>' +
      catsCaja.map(c => `<option>${esc(c)}</option>`).join('');
    cj.value = a; }
  rellenarLocalesDelCatalogo();
}

// De quién es cada producto, para poder ir repartiéndolos (DECISIONES.md #45).
// Solo sirve —y solo se ve— desde el almacén principal, que es el único que tiene
// delante el catálogo entero: en una tienda todos los que se ven son suyos o los
// ha tenido, y filtrar por local no diría nada.
//
// «Todavía sin local» es la razón de ser de este filtro: es la lista de lo que
// queda por repartir, y sin ella habría que buscarlos de uno en uno entre todos.
function rellenarLocalesDelCatalogo() {
  const sel = $('f-local');
  if (!sel) return;
  const antes = sel.value;
  sel.innerHTML = '<option value="">De cualquier local</option>' +
    '<option value="sin">Todavía sin local</option>' +
    SITIOS.map(x => `<option value="${x.id}">${esc(x.nombre)}</option>`).join('');
  sel.value = antes;
  if (sel.value !== antes) sel.value = '';   // el local se apagó: se vuelve a todos
}

// El filtro por local de Productos (#45). Vive en una función porque lo miran dos
// sitios —la lista y el PDF— y dos copias parecidas son dos copias que un día
// dejan de coincidir: el papel diría otra cosa que la pantalla desde la que se
// pidió.
function deEsteLocal(lista) {
  const sel = $('f-local'), v = sel ? sel.value : '';
  if (!v) return lista;
  // «Sin local» es exactamente lo que dice: no tiene local. También los pocos que
  // además tienen mercancía en algún sitio —a los que se les quitó el local
  // después—, porque son justo los que hay que repartir y esconderlos aquí sería
  // esconderlos en la única pantalla desde la que se les puede poner uno.
  return lista.filter(p => v === 'sin' ? !p.sitio_id : p.sitio_id === v);
}
const nombreDelFiltroLocal = () => {
  const sel = $('f-local'), v = sel ? sel.value : '';
  if (!v) return '';
  return v === 'sin' ? 'todavía sin local'
    : 'del local ' + ((SITIOS.find(x => x.id === v) || {}).nombre || '');
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ─── La lista del apartado de Productos ───────────────────────
// Es el catálogo: qué productos existen, cómo son y de quién son. Lo que HAY de
// cada uno se mira en el Almacén, que es otra pregunta (#22).
function renderLista() {
  if (!$('lista')) return;
  const q = ($('busq').value || '').trim().toLowerCase();
  const cat = $('f-cat').value;
  const orden = $('f-orden').value;

  // Esta pantalla ES el apartado de Productos (#45): aquí, y solo aquí, salen
  // también los que todavía no tienen local.
  const aqui = productosDelApartado();
  let lista = aqui;
  if (cat) lista = lista.filter(p => p.categoria === cat);
  lista = deEsteLocal(lista);
  if (q) {
    // Busca por nombre, por el código de la app y por el del fabricante: se teclea
    // lo que se tenga a mano.
    lista = lista.filter(p =>
      (p.nombre || '').toLowerCase().includes(q) ||
      (p.codigo || '').toLowerCase().includes(q) ||
      (p.codigo_barra || '').toLowerCase().includes(q) ||
      (p.categoria || '').toLowerCase().includes(q));
  }
  if (orden === 'alfa') lista.sort((a, b) => a.nombre.localeCompare(b.nombre));
  else if (orden === 'codigo') lista.sort((a, b) => (a.codigo || '').localeCompare(b.codigo || ''));
  else if (orden === 'caro') lista.sort((a, b) => b.precio - a.precio);
  else if (orden === 'barato') lista.sort((a, b) => a.precio - b.precio);

  $('cuenta').textContent = lista.length === aqui.length
    ? lista.length + (lista.length === 1 ? ' producto' : ' productos')
    : lista.length + ' de ' + aqui.length;

  $('lista').innerHTML = lista.length ? lista.map(p => {
    const excep = (p.precios || []).length;
    const sub = [p.categoria, p.um !== 'Unidad' ? p.um : null,
                 p.unidades_por_caja > 0 ? rotuloBulto(p) : null,
                 excep ? excep + (excep === 1 ? ' precio especial' : ' precios especiales') : null,
                 // Que se vea de un vistazo cuáles quedan por repartir (#45), y se
                 // le dice a todo el mundo: es lo que explica por qué ese producto
                 // no sale en la caja ni en el almacén.
                 !p.sitio_id ? 'todavía sin local' : null]
                .filter(Boolean).join(' · ');
    return `<div class="prod" onclick="abrirFicha('${p.id}')">
      ${p.tiene_foto ? `<img class="miniFoto" src="${fotoDe(p)}" alt="" loading="lazy">`
               : `<span class="cod">${esc(p.codigo)}</span>`}
      <div class="info">
        <div class="nm">${esc(p.nombre)}${p.tiene_foto ? ' <span style="font-size:10.5px;color:var(--texto3)">' + esc(p.codigo) + '</span>' : ''}</div>
        ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}
      </div>
      <div class="pre"><b class="num">${dinero(p.precio, p.precio_moneda || 'CUP')}</b>
        ${p.costo === null ? ''
          : `<span${costoRaro(p) ? ' style="color:var(--rojo);font-weight:700"' : ''}>costo ${
              enBase(p.costo)}</span>`}</div>
      <span class="accIco editar" title="Tocar para editar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z"/></svg></span>
    </div>`;
  }).join('') : `<div class="vacio">${q || cat ? 'Ningún producto coincide con la búsqueda.' :
      'Todavía no hay productos.<br>Empieza creando el primero.'}</div>`;
}

// Un costo que se sale de madre. Casi siempre es el mismo accidente: el costo
// escrito en una moneda y guardado como si fuera la otra, que lo deja unas cien
// veces más grande o más pequeño de lo que es. Pasó de verdad, y el fallo no se
// veía en ninguna pantalla: solo en la ganancia del mes, ya tarde.
//
// Se marca en rojo y no se corrige solo: la app no sabe cuál era el número
// bueno, y ponerle uno inventado sería peor que el fallo.
function costoRaro(p) {
  if (!p || !(p.costo > 0) || !(p.precio > 0)) return false;
  const precio = convertir(p.precio, p.precio_moneda || 'CUP', MONEDA_BASE);
  if (precio === null || !precio) return false;
  return p.costo > precio;      // vender por debajo del costo no se hace a propósito
}

// ─── Fotos ────────────────────────────────────────────────────
// La foto se encoge AQUI, antes de mandarla. Una foto de telefono son 3 o 4 MB;
// guardada tal cual engordaria la base de datos y, sobre todo, cada archivo de
// copia de seguridad que haya que mandar por WhatsApp. A 480px y en JPEG queda
// en unas decenas de KB y se ve perfecta en el mostrador.
function encogerFoto(archivo, cuandoEste, lado) {
  const lector = new FileReader();
  lector.onload = () => {
    const img = new Image();
    img.onload = () => {
      const max = lado || 480;
      let a = img.width, h = img.height;
      const escala = Math.min(1, max / Math.max(a, h));
      a = Math.round(a * escala); h = Math.round(h * escala);
      const lienzo = document.createElement('canvas');
      lienzo.width = a; lienzo.height = h;
      lienzo.getContext('2d').drawImage(img, 0, 0, a, h);
      cuandoEste(lienzo.toDataURL('image/jpeg', 0.72));
    };
    img.onerror = () => alert('Ese archivo no parece una imagen.');
    img.src = lector.result;
  };
  lector.readAsDataURL(archivo);
}

function elegirFoto(ev) {
  const f = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  encogerFoto(f, datos => {
    fotoActual = datos;
    pintarFoto();
    toast('✓ Foto lista (' + Math.round(datos.length / 1024) + ' KB)');
  });
}
// Quitarla es mandar vacío A PROPÓSITO. 'undefined' significa otra cosa —«no la he
// tocado, déjala como está»— y el servidor las distingue: confundirlas borraría la
// foto de cada producto que se editara para cambiarle el precio.
function quitarFoto() { fotoActual = null; pintarFoto(); }

function pintarFoto() {
  // Tres estados, y hay que verlos: la foto NUEVA que se acaba de hacer (llega como
  // datos), la que YA tenía el producto (que ahora no viaja en el catálogo y se pide
  // por su dirección), y sin foto.
  const src = fotoActual ? fotoActual
    : (fotoActual === undefined && fotoDe(FICHA_PRODUCTO)) || '';
  $('f-foto-prev').innerHTML = src ? '<img src="' + src + '" alt="">' : '<span>Sin foto</span>';
  $('f-foto-quitar').style.display = src ? 'inline-flex' : 'none';
}

// La dirección de la foto de un producto. Ya no viaja dentro del catálogo: eran
// 2 MB en cada arranque de la aplicación, por el internet de un teléfono, antes de
// ver un solo precio. Ahora cada foto se pide aparte y el navegador la guarda.
//
// El '?v=' es la fecha de la última edición del producto, y es lo que hace que la
// caché pueda ser eterna: al cambiar la foto cambia la dirección, y el teléfono se
// entera solo. Sin él habría que elegir entre fotos viejas o volver a bajarlas.
const fotoDe = p => !p || !p.tiene_foto ? ''
  : '/foto-producto/' + p.id + '?v=' + encodeURIComponent(p.actualizado || '');

// ─── Ficha del producto ───────────────────────────────────────
// 'copiar' abre la ficha de un producto que ya existe, pero para crear OTRO con
// lo suyo dentro (DECISIONES.md #45). Se rellena exactamente igual: lo único que
// cambia es que al guardar nace un producto nuevo en vez de cambiar este.
function abrirFicha(id, copiar) {
  editando = copiar ? null : (id || null);
  const p = id ? PRODUCTOS.find(x => x.id === id) : null;
  const naciendo = !editando;      // uno en blanco, o una copia: todavía no existe

  $('ficha-titulo').textContent = copiar ? 'Copia de un producto'
    : (p ? 'Editar producto' : 'Nuevo producto');
  // El código de la aplicación lo pone el servidor al crear: en una copia todavía
  // no hay ninguno que enseñar, y enseñar el del original sería mentir.
  $('ficha-codigo-caja').style.display = naciendo ? 'none' : 'block';
  if (p) $('ficha-codigo').textContent = p.codigo;
  $('btn-borrar').style.display = naciendo ? 'none' : 'inline-flex';
  $('btn-duplicar').style.display = (!naciendo && puedo('gestionar_productos'))
    ? '' : 'none';

  // El producto que se está editando, para poder pintar la foto que ya tiene: el
  // catálogo ya no la trae dentro.
  FICHA_PRODUCTO = p;
  // 'undefined' = no se ha tocado. Al guardar no se manda y el servidor deja la que
  // haya. En un producto nuevo no hay ninguna, así que es null desde el principio.
  // En una copia se empieza sin foto y la del original se trae aparte, porque ya
  // no viaja dentro del catálogo (#36): hay que ir a buscarla.
  fotoActual = (p && !copiar) ? undefined : null;
  pintarFoto();
  // El nombre lleva «(copia)» para que no queden dos iguales si alguien guarda sin
  // mirar. Se abre seleccionado, así se escribe encima del tirón.
  $('f-nombre').value = !p ? '' : (copiar ? p.nombre + ' (copia)' : p.nombre);
  $('f-cat-in').value = p ? p.categoria : '';
  ponerListasDelProducto(p);
  // El código del fabricante es el que ESE producto trae impreso en la caja, y no
  // es el mismo del que se le parece: en una copia se deja en blanco a propósito.
  $('f-codbarra').value = (p && !copiar) ? (p.codigo_barra || '') : '';
  $('f-costo').value = p ? p.costo : '';
  $('f-costorepo').value = p && p.costo_repo > 0 ? p.costo_repo : '';
  // Siempre se abre en CUP: lo guardado está en pesos, y enseñarlo en dólares
  // haría creer que el número de la casilla es lo que se pagó en dólares.
  $('f-costo-moneda').value = MONEDA_BASE;
  equivalenciaCosto();
  $('f-precio').value = p ? p.precio : '';
  $('f-precio-moneda').value = p ? (p.precio_moneda || 'CUP') : 'CUP';
  equivalencia();
  $('f-stockmin').value = p ? p.stock_min : '';
  // (la unidad y el bulto los pone ponerListasDelProducto, más arriba)

  // De qué local es (#45). Al crear uno en blanco se propone el local en el que se
  // está trabajando, que es lo que quiere decir «lo estoy creando aquí». Al editar
  // o al copiar, el que tenga; y si no tiene ninguno, se queda en «todavía sin
  // local», que es una respuesta de verdad y no un hueco sin rellenar: el dueño
  // mete el catálogo de una tanda y les va poniendo local después.
  if ($('f-sitio')) {
    $('f-sitio').innerHTML =
      '<option value="">Todavía sin local — se lo pongo después</option>' +
      SITIOS.map(s => `<option value="${s.id}">${esc(s.nombre)}</option>`).join('');
    $('f-sitio').value = p ? (p.sitio_id || '') : sitioActual();
  }

  // La existencia inicial solo se pregunta al CREAR, y solo a quien puede mover
  // mercancía: apuntarla es registrar una entrada, y eso tiene su propio permiso.
  // Quien solo lleva el catálogo no ve la casilla, porque el servidor le
  // rechazaría la entrada cuando el producto ya estuviera creado.
  fichaNaciendo = naciendo;
  $('f-existencia').value = '';
  alCambiarLocalDeLaFicha();
  $('f-comision').value = p && p.comision > 0 ? p.comision : '';
  $('f-comision-tipo').value = p ? String(p.comision_pct || 0) : '0';
  // Se abre en la moneda del negocio porque lo guardado ESTÁ en esa moneda.
  // Enseñarlo con la otra puesta haría creer que el número de la casilla es lo
  // que se le da en esa otra moneda, que es el fallo que dejó los costos 690
  // veces más grandes en agosto.
  $('f-comision-moneda').value = MONEDA_BASE;
  alCambiarComision();

  // Excepciones de precio: una fila por sitio
  const precios = {};
  (p && p.precios || []).forEach(x => { precios[x.sitio_id] = x.precio; });
  $('ficha-precios').innerHTML = SITIOS.map(s => `
    <div class="sitioPrecio">
      <span class="nmS">${esc(s.nombre)}</span>
      <input type="number" inputmode="decimal" data-sitio="${s.id}"
             placeholder="general" value="${precios[s.id] != null ? precios[s.id] : ''}">
    </div>`).join('');

  $('velo-ficha').classList.add('abierto');
  if (!p) setTimeout(() => $('f-nombre').focus(), 120);
}

function cerrarFicha() {
  $('velo-ficha').classList.remove('abierto');
  editando = null;
}

// En qué local nace el producto. Quien no elige local —porque no tiene el permiso
// de ver el negocio entero— lo crea en el suyo, que es donde está trabajando.
function localDeLaFicha() {
  const sel = $('f-sitio');
  return (puedo('ver_negocio_entero') && sel) ? sel.value : sitioActual();
}

// LA CASILLA DE «¿CUÁNTO TIENES AHORA?» VA PEGADA AL LOCAL (#45). La mercancía
// tiene que estar EN algún sitio, y un producto que se deja «todavía sin local» no
// tiene dónde meterla: por eso no suma en ninguna parte. Así que la pregunta
// aparece y desaparece con el local elegido, y dice en cuál va a entrar.
//
// Sin esto, meter el catálogo de una tanda —que es para lo que existe «todavía sin
// local»— apuntaría cada existencia en el local donde se esté parado, y el
// producto acabaría viéndose allí de todas formas, por sus movimientos.
function alCambiarLocalDeLaFicha() {
  const donde = localDeLaFicha();
  const puedeExistencia = fichaNaciendo && puedo('gestionar_inventario') && !!donde;
  $('f-existencia-caja').style.display = puedeExistencia ? 'block' : 'none';
  if (!puedeExistencia) return;
  const nombre = (SITIOS.find(s => s.id === donde) || {}).nombre || 'este sitio';
  $('f-existencia-pista').innerHTML = 'Se apunta como entrada de mercancía en <b>' +
    esc(nombre) + '</b>, al costo de arriba. Déjalo vacío si todavía no ha llegado.';
}

async function guardarProducto() {
  const nombre = $('f-nombre').value.trim();
  if (!nombre) { toast('⚠ Ponle nombre al producto'); $('f-nombre').focus(); return; }
  const precio = parseFloat($('f-precio').value) || 0;
  if (precio <= 0) { toast('⚠ Ponle precio de venta'); $('f-precio').focus(); return; }
  // Se mira ANTES de crear nada: si la cantidad está mal, se avisa con el
  // producto todavía sin crear y se arregla escribiéndola bien. Después ya no,
  // porque el producto existiría y volver a darle a Guardar crearía otro.
  const existencia = existenciaEscrita();
  if (existencia !== null && !(existencia > 0)) {
    toast('⚠ La cantidad que hay tiene que ser mayor que cero');
    $('f-existencia').focus(); return;
  }

  const cuerpo = {
    nombre,
    categoria: $('f-cat-in').value.trim(),
    um: $('f-um').value.trim() || 'Unidad',
    codigo_barra: $('f-codbarra').value.trim(),
    // El costo se guarda SIEMPRE en la moneda del negocio (Ajustes → Moneda de
    // la empresa), NO en pesos: desde el 14 de agosto de 2026 el negocio puede
    // medirse en dólares. Si se escribió en la otra moneda se pasa aquí, con el
    // valor de hoy, y ese número ya no se mueve: lo que costó, costó, aunque
    // mañana cambie el dólar. Esta nota decía «siempre en pesos» y era mentira
    // desde ese día; con la medida en dólares, creérsela deja el costo 690 veces
    // más grande y la ganancia del trabajo en negativo.
    costo: costoEnBase('f-costo'),
    costo_repo: costoEnBase('f-costorepo'),
    precio,
    precio_moneda: $('f-precio-moneda').value === 'USD' ? 'USD' : 'CUP',
    stock_min: parseFloat($('f-stockmin').value) || 0,
    // El bulto (#44). No cambia ni un movimiento: lo guardado son unidades, y
    // esto solo dice cómo se escriben y cómo se leen de aquí en adelante.
    unidades_por_caja: parseFloat($('f-porcaja').value) || 0,
    nombre_caja: $('f-nombrecaja').value.trim() || null,
    // La foto solo va si se ha tocado. JSON.stringify quita las claves con
    // 'undefined', así que no mandarla y mandarla vacía llegan distintas al
    // servidor, que es lo que le deja saber si tiene que dejar la que ya había.
    foto: fotoActual,
    // La comisión fija se guarda en la moneda del NEGOCIO, como el costo: es la
    // única forma de poder sumar lo que se le debe a alguien que ha vendido
    // productos con comisiones escritas en monedas distintas (DECISIONES.md #21).
    // Escribirla en la otra es cómodo y se convierte aquí, con el dólar de hoy.
    // El porcentaje NO se toca: un 5% es un 5% en cualquier moneda.
    comision: Number($('f-comision-tipo').value) ? (parseFloat($('f-comision').value) || 0)
                                                 : comisionEnBase(),
    comision_pct: Number($('f-comision-tipo').value) || 0,
    precios: [...document.querySelectorAll('#ficha-precios input')]
      .map(i => ({ sitio_id: i.dataset.sitio, precio: i.value === '' ? null : parseFloat(i.value) }))
      .filter(x => x.precio === null || x.precio > 0)
  };

  // De qué local es (DECISIONES.md #45). El desplegable solo lo tiene delante quien
  // ve el negocio entero; quien no, no manda el campo, y no mandarlo significa
  // «déjalo donde está». Para él eso es justo lo que tiene que pasar: si se mandara
  // vacío, guardarle el precio a un producto lo dejaría sin local.
  //
  // Y vacío SÍ es una respuesta —«todavía sin local»—, así que lo que se mira es si
  // el desplegable está delante, no si tiene algo escrito.
  const eligeLocal = puedo('ver_negocio_entero') && !!$('f-sitio');
  if (eligeLocal) cuerpo.sitio_id = $('f-sitio').value;
  else if (!editando) cuerpo.sitio_id = sitioActual();

  try {
    if (editando) {
      await api('/api/productos/' + editando, { method: 'PUT', body: JSON.stringify(cuerpo) });
      toast('✓ Producto actualizado');
    } else {
      const r = await api('/api/productos', { method: 'POST', body: JSON.stringify(cuerpo) });
      // La existencia con la que nace el producto es una ENTRADA, no un campo
      // suyo (#1), y va después de crearlo porque hasta aquí no hay a qué
      // producto apuntarla.
      const aviso = await apuntarExistenciaInicial(r.id, cuerpo.costo, existencia,
                                                   localDeLaFicha());
      // Sin impresora, este código hay que escribirlo a mano en el producto. Si
      // solo saliera en un aviso que se va solo, habría que buscarlo después.
      cerrarFicha();
      await cargarCatalogo();
      // El almacén se repinta entero: acaba de entrar mercancía y la lista, el
      // valor del inventario y el reparto por sitios se han quedado viejos.
      if ($('p-almacen').classList.contains('activa')) await cargarAlmacen();
      mostrarCodigoNuevo(r.codigo, nombre, aviso);
      return;
    }
    cerrarFicha();
    await cargarCatalogo();
  } catch (e) { alert('No se pudo guardar: ' + e.message); }
}

// Lo escrito en «¿Cuánto tienes ahora?», o null si la casilla no está a la vista
// o se dejó vacía. Vacío y cero no son lo mismo aquí: vacío es «todavía no ha
// llegado» y no apunta nada; un cero escrito a mano es un despiste que conviene
// devolver, porque una entrada de cero unidades no existe.
function existenciaEscrita() {
  const caja = $('f-existencia-caja');
  if (!caja || caja.style.display === 'none') return null;
  const txt = ($('f-existencia').value || '').trim();
  if (txt === '') return null;
  const n = parseFloat(txt);
  return isNaN(n) ? 0 : n;
}

// Apunta la entrada con la que nace el producto. Devuelve null si fue bien, o
// el aviso que hay que enseñar si no: el producto YA está creado, así que
// tragarse el fallo dejaría el inventario diciendo cero con la mercancía en el
// estante. Pasa de verdad cuando la jornada de ese sitio ya está cerrada, o
// cuando se cae el internet entre las dos peticiones.
// La entrada va al local del PRODUCTO, no al que se esté mirando: desde el almacén
// principal se crean cosas que son de una tienda, y meterlas en el almacén las
// dejaría contadas donde no están (#45).
async function apuntarExistenciaInicial(productoId, costoBase, cantidad, sitioId) {
  if (!(cantidad > 0) || !sitioId) return null;
  const donde = (SITIOS.find(s => s.id === sitioId) || {}).nombre || 'el sitio';
  try {
    await api('/api/movimientos', { method: 'POST', body: JSON.stringify({
      tipo: 'compra',
      sitio_id: sitioId,
      producto_id: productoId,
      cantidad,
      costo_unit: costoBase,
      obs: 'Existencia con la que se dio de alta el producto',
      fecha: new Date().toLocaleDateString('sv-SE')
    }) });
    return { mal: false, texto: 'Se apuntaron ' + cantidad + ' en ' + donde + '.' };
  } catch (e) {
    return { mal: true, texto: 'El producto se creó, pero la existencia NO se pudo apuntar: ' +
      e.message + ' Apúntala con el botón «Entrada» del almacén.' };
  }
}

// Se queda en pantalla hasta que la persona lo cierra: es el momento de coger
// el marcador y escribirlo en el producto.
function mostrarCodigoNuevo(codigo, nombre, aviso) {
  $('nc-codigo').textContent = codigo;
  $('nc-nombre').textContent = nombre;
  const av = $('nc-aviso');
  av.style.display = aviso ? 'block' : 'none';
  if (aviso) {
    av.textContent = aviso.texto;
    av.style.color = aviso.mal ? 'var(--rojo)' : 'var(--texto2)';
    av.style.fontWeight = aviso.mal ? '700' : '400';
  }
  $('velo-codigo').classList.add('abierto');
}
function cerrarCodigoNuevo() { $('velo-codigo').classList.remove('abierto'); }

async function borrarProducto() {
  const p = PRODUCTOS.find(x => x.id === editando);
  if (!p) return;
  if (!confirm('¿Eliminar "' + p.nombre + '" del catálogo?\n\n' +
               'Los movimientos que ya tenga se conservan: el historial no se toca.')) return;
  try {
    await api('/api/productos/' + editando, { method: 'DELETE' });
    toast('✓ Eliminado');
    cerrarFicha();
    await cargarCatalogo();
  } catch (e) { alert('No se pudo eliminar: ' + e.message); }
}

// ─── Duplicar un producto ─────────────────────────────────────
// Se copia todo lo que se parece —categoría, unidad, bulto, costos, precio con sus
// excepciones por local, comisión, mínimo, local y foto— y se quedan fuera las dos
// cosas que son de ESE producto y de ningún otro: el código de la aplicación, que
// lo pone el servidor al crear, y el código del fabricante, que es el que viene
// impreso en su caja.
//
// No se guarda nada todavía: se abre la ficha con lo copiado dentro y no nace
// ningún producto hasta que se pulsa Guardar. La otra forma —crear la copia en el
// servidor y abrirla para editarla— deja un producto suelto cada vez que alguien
// se arrepiente.
async function duplicarProducto() {
  const p = PRODUCTOS.find(x => x.id === editando);
  if (!p) return;
  abrirFicha(p.id, true);
  toast('Cambia lo que sea distinto y dale a Guardar');
  const foto = await fotoComoDatos(p);
  // Traer la foto tarda un momento, y en ese momento se puede haber cerrado la
  // ficha o abierto otra: pegarla entonces se la pondría al producto equivocado.
  if (editando || FICHA_PRODUCTO !== p) return;
  fotoActual = foto;
  pintarFoto();
}

// La foto de un producto, tal como habría que mandarla al crear otro: los mismos
// datos que manda la cámara. Ya no viaja dentro del catálogo (#36), así que hay
// que ir a buscarla. Si no se puede traer se sigue sin ella: quedarse sin foto en
// una copia es un fastidio, no un fallo, y no vale la pena parar por eso.
function fotoComoDatos(p) {
  if (!p || !p.tiene_foto) return Promise.resolve(null);
  return fetch(fotoDe(p))
    .then(r => r.ok ? r.blob() : null)
    .then(b => b && new Promise(res => {
      const l = new FileReader();
      l.onload = () => res(l.result);
      l.onerror = () => res(null);
      l.readAsDataURL(b);
    }))
    .catch(() => null);
}

// ═══════════════════════════════════════════════════════════════
//  CAJA
// ═══════════════════════════════════════════════════════════════
// El carro vive solo en el dispositivo hasta que se cobra. Al cobrar se crea la
// venta y sus movimientos, y el stock baja porque baja la suma (DECISIONES #1).

let SITIO = localStorage.getItem('dp_sitio') || '';
let STOCK = {};
// El carrito vive en el dispositivo hasta que se cobra, y se guarda: cambiar de
// pantalla o refrescar sin querer no puede borrar una venta a medio anotar.
let CARRO = [];   // [{producto_id, nombre, codigo, precio, cantidad}]
function guardarCarro() {
  try { localStorage.setItem('dp_carro_' + sitioActual(), JSON.stringify(CARRO)); } catch (e) {}
}
function recuperarCarro() {
  try { CARRO = JSON.parse(localStorage.getItem('dp_carro_' + sitioActual()) || '[]') || []; }
  catch (e) { CARRO = []; }
}

function sitioActual() { return SITIO || (SITIOS[0] && SITIOS[0].id) || ''; }

// ─── DE QUÉ LOCAL ES CADA PRODUCTO (DECISIONES.md #45) ──────
// Cada tienda y cada almacén tiene los suyos: los que se crearon allí MÁS los que
// ha tenido alguna vez —lo que le despachó el almacén, lo que le trajo una
// inversión—. Esa segunda mitad no es un adorno: sin ella, la mercancía que llega
// de fuera no se podría vender, porque se creó en otro local y no saldría en la
// pantalla de quien la tiene delante.
//
// Y se mira si ha HABIDO movimiento, no si queda existencia: una tienda que
// vendió hasta el último saco tiene que seguir viéndolo, porque mañana le mandan
// más. Si se fuera al llegar a cero, desaparecería justo el día que hay que pedirlo.
//
// El almacén principal los ve TODOS: es el mirador del negocio (#22) y quien está
// allí necesita ver también lo que cada tienda se ha creado por su cuenta.
//
// Y UN PRODUCTO SUELTO NO SE VE EN NINGÚN LOCAL. Suelto es el que todavía no tiene
// local Y nunca ha tenido mercancía en ninguno: el que se acaba de escribir en
// Productos y está esperando que le pongan sitio. Ese vive SOLO en el apartado de
// Productos —ni en la caja, ni en el almacén, ni en el mirador— hasta que se le
// asigna uno.
//
// El «y nunca ha tenido mercancía» no es un adorno: si a un producto con
// existencias en la tienda se le quitara el local, esconderlo dejaría esa
// mercancía sin poder venderse y sin que nadie entendiera por qué. Mientras haya
// movimientos suyos en un local, ese local lo sigue viendo.
const estaSuelto = p => !p.sitio_id && !(p.sitios || []).length;

function veAqui(p) {
  if (estaSuelto(p)) return false;
  if (enElMirador()) return true;
  const aqui = sitioActual();
  return p.sitio_id === aqui || (p.sitios || []).includes(aqui);
}
const productosAqui = () => PRODUCTOS.filter(p => !p.borrado_en && veAqui(p));

// EL APARTADO DE PRODUCTOS es la excepción, y la razón de ser de todo esto: aquí
// salen los de este local MÁS los que todavía no tienen ninguno, porque es donde
// se crean y desde donde se les pone local. Si no salieran aquí no saldrían en
// ninguna parte, y no habría manera de asignarlos.
const productosDelApartado = () =>
  PRODUCTOS.filter(p => !p.borrado_en && (veAqui(p) || estaSuelto(p)));

// LO QUE ENSEÑA EL ALMACÉN. Mirando el negocio sumado salen todos los productos
// asignados: es justo lo que se ha pedido ver, y el almacén principal es la suma
// de todos los demás (#22). Mirando este local, los de este local.
//
// Los que todavía no tienen local no están en ninguna de las dos vistas, ni
// siquiera en la suma: aquí se cuentan existencias, y un producto sin local
// todavía no es de nadie (#45).
const productosDelAlmacen = () => $('alm-alcance').value === 'todos'
  ? PRODUCTOS.filter(p => !p.borrado_en && !estaSuelto(p))
  : productosAqui();

// El precio guardado va en la moneda del propio producto; aquí se pasa a la
// que se esté cobrando. Es el mismo cálculo que hace el servidor, que es quien
// manda: esto solo sirve para enseñarlo antes de cobrar.
function precioEnSitio(p, moneda) {
  const ex = (p.precios || []).find(x => x.sitio_id === sitioActual());
  const base = ex && ex.precio > 0 ? ex.precio : p.precio;
  const conv = convertir(base, p.precio_moneda || 'CUP', moneda || MONEDA);
  return conv === null ? null : ((moneda || MONEDA) === 'USD'
    ? Math.round(conv * 100) / 100 : Math.round(conv));
}
const precioTexto = p => {
  const v = precioEnSitio(p);
  return v === null ? '— sin tasa' : dinero(v, MONEDA);
};

async function cargarTasa() {
  try {
    const d = await api('/api/tasa');
    TASA = d.tasa || 0;
    MONEDA_BASE = d.moneda_base === 'USD' ? 'USD' : 'CUP';
    VENDER_SIN_STOCK = !!d.vender_sin_stock;
    if ($('sin-stock')) $('sin-stock').checked = VENDER_SIN_STOCK;
    if ($('mb-actual')) $('mb-actual').textContent = MONEDA_BASE;
    if ($('mb-moneda')) $('mb-moneda').value = MONEDA_BASE;
  } catch (e) { TASA = 0; }
  const inp = $('tasa-valor');
  if (inp && !inp.value && TASA) inp.value = TASA;
  const nota = $('tasa-nota');
  if (nota) nota.textContent = TASA
    ? 'Ahora mismo: 1 USD = ' + TASA + ' CUP. Un producto de 100 USD se cobra a ' +
      Math.round(100 * TASA).toLocaleString('es-CU') + ' CUP.'
    : 'Sin valor puesto no se puede cobrar en la otra moneda: la app avisará en vez de inventarse un cambio.';
}

async function guardarTasa() {
  const t = parseFloat($('tasa-valor').value);
  if (!(t > 0)) { toast('⚠ Pon cuántos CUP vale un dólar'); return; }
  try {
    await api('/api/tasa', { method: 'POST', body: JSON.stringify({ tasa: t }) });
    TASA = t;
    await cargarTasa();
    renderResultados(); renderCarro();
    toast('✓ 1 USD = ' + t + ' CUP');
  } catch (e) { alert('No se pudo guardar: ' + e.message); }
}

function cambiarMonedaCaja() {
  MONEDA = $('caja-moneda').value;
  localStorage.setItem('dp_moneda', MONEDA);
  if (MONEDA === 'USD' && !TASA) {
    alert('Falta poner el valor del dólar en Ajustes.\n\nSin él la app no puede saber a ' +
          'cuánto se cobra en USD un producto marcado en CUP.');
  }
  // El carro se rehace: los precios cambian de moneda
  CARRO.forEach(l => {
    const p = PRODUCTOS.find(x => x.id === l.producto_id);
    if (p) l.precio = precioEnSitio(p) || 0;
  });
  renderResultados();
  renderCarro();
}

// Los locales en los que se mueve quien está dentro. El servidor los manda al
// entrar; null quiere decir «en todos». Se usa para no OFRECER un sitio en el que
// el servidor va a contestar 403: prometer algo que no se va a cumplir es peor que
// no ofrecerlo (decisión #39). SITIOS sigue entero a propósito, para poder poner
// el nombre de un sitio ajeno cuando aparece en un traslado o en un apunte viejo.
function misSitios() {
  const m = YO && YO.mis_sitios;
  return Array.isArray(m) ? SITIOS.filter(s => m.includes(s.id)) : SITIOS;
}

function pintarSelectorSitio() {
  // Si el sitio guardado en este teléfono ya no es uno de los suyos —le cambiaron
  // el local, o el cargo—, se pasa al primero que sí lo sea. Sin esto se quedaría
  // trabajando contra un sitio que el servidor le niega en cada petición, y el
  // desplegable enseñaría un nombre que no es el que manda.
  const suyos = misSitios();
  if (suyos.length && !suyos.some(s => s.id === sitioActual())) {
    SITIO = suyos[0].id;
    localStorage.setItem('dp_sitio', SITIO);
  }
  const opciones = suyos.map(s =>
    `<option value="${s.id}"${s.id === sitioActual() ? ' selected' : ''}>${esc(s.nombre)}</option>`).join('');
  ['sitio-actual', 'sitio-almacen'].forEach(id => { if ($(id)) $(id).innerHTML = opciones; });
  SITIO = sitioActual();
}

// El sitio es uno solo para toda la app: cambiarlo en la caja lo cambia en el
// almacén y al revés, para que nadie venda en un sitio creyendo estar en otro.
async function cambiarSitioDesde(id) {
  $('sitio-actual').value = $(id).value;
  await cambiarSitio();
  await cargarAlmacen();
  if ($('p-ventas').classList.contains('activa')) await cargarDia();
}

async function cambiarSitio() {
  SITIO = $('sitio-actual').value;
  localStorage.setItem('dp_sitio', SITIO);
  recuperarCarro();
  await cargarStock();
  renderCarro();
  // El catálogo cambia con el local (#45): los productos que se ven son otros, y
  // las categorías también. Sin repintarlos aquí, al cambiar de tienda se seguiría
  // viendo la lista de la anterior hasta salir y volver a entrar.
  rellenarCategorias();
  renderLista();
  renderResultados();
  toast('Vendiendo en ' + (SITIOS.find(s => s.id === SITIO) || {}).nombre);
}

async function cargarStock() {
  try {
    const d = await api('/api/stock?sitio_id=' + encodeURIComponent(sitioActual()));
    STOCK = d.stock || {};
  } catch (e) { STOCK = {}; }
}

function pillStock(id) {
  const n = Number(STOCK[id] || 0);
  const clase = n <= 0 ? 'nada' : (n <= 5 ? 'poco' : '');
  return `<span class="stockPill ${clase}">${n} u.</span>`;
}

// Sin escribir nada, la caja enseña lo que hay disponible para tocarlo y
// venderlo. Buscar sirve para ir rápido cuando el catálogo crece, pero obligar
// a escribir para ver la mercancía es hacer trabajar de más a quien despacha.
function renderResultados() {
  const q = ($('caja-busq').value || '').trim().toLowerCase();
  const cat = $('caja-cat') ? $('caja-cat').value : '';
  const cont = $('caja-resultados');
  // Solo los de este local (#45): quien despacha no tiene por qué buscar entre los
  // productos de las otras tiendas para encontrar los que tiene delante.
  let lista = productosAqui();
  if (cat) lista = lista.filter(p => p.categoria === cat);

  if (q) {
    lista = lista.filter(p =>
      (p.nombre || '').toLowerCase().includes(q) ||
      (p.codigo || '').toLowerCase().includes(q) ||
      (p.codigo_barra || '').toLowerCase().includes(q)).slice(0, 10);
    cont.innerHTML = lista.length ? lista.map(p => `
      <div class="prod" onclick="alCarro('${p.id}')">
        <span class="cod">${esc(p.codigo)}</span>
        <div class="info"><div class="nm">${esc(p.nombre)}</div>
          <div class="sub">${pillStock(p.id)} ${esc(p.um)}</div></div>
        <div class="pre"><b class="num">${precioTexto(p)}</b></div>
        <span class="accIco anadir" title="Tocar para añadir"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></span>
      </div>`).join('')
      : '<div class="vacio" style="padding:18px">Nada con «' + esc(q) + '»</div>';
    return;
  }

  // El catálogo entero, no solo lo que tiene existencia: con el almacén recién
  // montado no habría nada que tocar y la caja se quedaría en blanco. Lo que
  // hay va primero; lo agotado se ve apagado, pero se puede vender igual y la
  // app avisa de que el inventario queda en negativo.
  if (!lista.length) {
    cont.innerHTML = `<div class="vacio">${cat
      ? 'Nada en esa categoría.'
      : 'Todavía no hay productos.<br>Créalos en la pantalla de Productos.'}</div>`;
    return;
  }
  lista.sort((a, b) => {
    const ha = Number(STOCK[a.id] || 0) > 0, hb = Number(STOCK[b.id] || 0) > 0;
    if (ha !== hb) return ha ? -1 : 1;
    return a.nombre.localeCompare(b.nombre);
  });
  cont.innerHTML = '<div class="rejilla">' + lista.map(p => `
    <div class="fichaProd${Number(STOCK[p.id] || 0) > 0 ? '' : ' agotado'}" onclick="alCarro('${p.id}')">
      ${p.tiene_foto ? `<img class="foto" src="${fotoDe(p)}" alt="" loading="lazy">` : ''}
      <div class="nm">${esc(p.nombre)}</div>
      <div class="pr num">${precioTexto(p)}</div>
      <div class="pie"><span class="cod">${esc(p.codigo)}</span>${pillStock(p.id)}</div>
      <span class="accIco anadir" title="Tocar para añadir"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></span>
    </div>`).join('') + '</div>';
}

function alCarro(id) {
  const p = PRODUCTOS.find(x => x.id === id);
  if (!p) return;
  // No se vende lo que no está. Se para AQUÍ y no al cobrar: enterarse de que
  // no hay mercancía con el cliente delante y el carro montado es lo peor.
  if (!VENDER_SIN_STOCK && quedaEnCaja(id) < 1) {
    toast('⚠ No queda ' + p.nombre + '. Si llegó y no se apuntó, regístralo en Almacén.');
    return;
  }
  const linea = CARRO.find(l => l.producto_id === id);
  if (linea) linea.cantidad++;
  else {
    const pr = precioEnSitio(p);
    if (pr === null) { toast('⚠ Falta el valor del dólar en Ajustes'); return; }
    CARRO.push({ producto_id: id, nombre: p.nombre, codigo: p.codigo,
                 um: p.um, precio: pr, cantidad: 1 });
  }
  $('caja-busq').value = '';
  renderResultados();
  renderCarro();
  $('caja-busq').focus();
}

function cambiarCantidad(id, delta) {
  const l = CARRO.find(x => x.producto_id === id);
  if (!l) return;
  l.cantidad = Math.max(0, l.cantidad + delta);
  if (l.cantidad === 0) CARRO = CARRO.filter(x => x.producto_id !== id);
  renderCarro();
}

function ponerCantidad(id, valor) {
  const l = CARRO.find(x => x.producto_id === id);
  if (!l) return;
  const n = parseFloat(valor);
  let cant = isNaN(n) || n <= 0 ? 1 : n;
  const hay = Number(STOCK[id] || 0);
  if (!VENDER_SIN_STOCK && cant > hay) {
    toast('⚠ Solo hay ' + hay + ' de ' + l.nombre);
    cant = Math.max(1, hay);
  }
  l.cantidad = cant;
  renderCarro();
}

function quitarLinea(id) {
  CARRO = CARRO.filter(x => x.producto_id !== id);
  renderCarro();
}

function totalCarro() {
  return CARRO.reduce((s, l) => s + l.precio * l.cantidad, 0);
}

function renderCarro() {
  guardarCarro();
  const cont = $('carro');
  // Con el carro vacío la tarjeta se esconde entera: en un móvil, cada bloque
  // que no hace falta es un empujón más a lo que sí importa.
  $('carro-caja').style.display = CARRO.length ? 'block' : 'none';
  if (!CARRO.length) {
    cont.innerHTML = '';
    $('barra-cobro').style.display = 'none';
    return;
  }
  cont.innerHTML = CARRO.map(l => {
    const hay = Number(STOCK[l.producto_id] || 0);
    const falta = l.cantidad > hay;
    return `<div class="linea">
      <div class="nm">${esc(l.nombre)}
        <small>${esc(l.codigo)} · ${dinero(l.precio, MONEDA)} c/u${falta ? ' · ⚠ solo hay ' + hay : ''}</small></div>
      <div class="cant">
        <button onclick="cambiarCantidad('${l.producto_id}',-1)">−</button>
        <input type="number" inputmode="decimal" value="${l.cantidad}"
               onchange="ponerCantidad('${l.producto_id}',this.value)">
        <button onclick="cambiarCantidad('${l.producto_id}',1)">+</button>
      </div>
      <div class="imp">${dinero(l.precio * l.cantidad, MONEDA)}</div>
      <button class="quitar" onclick="quitarLinea('${l.producto_id}')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
  }).join('');
  $('carro-total').textContent = dinero(totalCarro(), MONEDA);
  $('barra-cobro').style.display = 'flex';
}

// ═══════════════════════════════════════════════════════════════
//  ESCÁNER
// ═══════════════════════════════════════════════════════════════
// Usa el lector de códigos que ya trae el navegador (BarcodeDetector). No se
// carga ninguna librería de fuera porque la app tiene que funcionar sin
// internet (DECISIONES.md #8), y una librería de códigos pesa más que toda la
// aplicación junta.
//
// DOS COSAS QUE HAY QUE SABER:
//  · La cámara solo funciona en localhost o por HTTPS. Por eso el servidor va
//    con candado y cada dispositivo instala el sello del negocio (DECISIONES.md
//    #13). Si alguien entra por http://…, el navegador la bloquea, y no es un
//    fallo de la app: es una regla de seguridad del navegador.
//  · Sin impresora no hay etiquetas propias que escanear. Esto sirve HOY para
//    los códigos que el producto ya trae de fábrica: se escanea una vez desde
//    la ficha, se engancha al producto, y a partir de ahí la caja lo reconoce.

let escFlujo = null, escBucle = null, escDesde = 'caja', escDetector = null;

async function abrirEscaner(desde) {
  escDesde = desde || 'caja';
  $('esc-titulo').textContent = escDesde === 'ficha'
    ? 'Escanear el código del fabricante' : 'Escanear para vender';
  $('esc-pista').textContent = escDesde === 'ficha'
    ? 'Apunta al código de barras impreso en el producto. Se guardará en esta ficha.'
    : 'Apunta al código del producto. Se añade solo a la venta.';
  $('esc-hallado').innerHTML = '';
  $('esc-estado').textContent = '';
  $('velo-escaner').classList.add('abierto');

  if (!('BarcodeDetector' in window)) {
    return sinEscaner('Este navegador no sabe leer códigos.\n\n' +
      'Funciona en Chrome sobre Android. Mientras tanto: teclea el código en el ' +
      'buscador, o conecta un lector de mostrador, que escribe solo y funciona ya.');
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return sinEscaner('Este navegador no da acceso a la cámara.');
  }
  try {
    escDetector = new BarcodeDetector({ formats:
      ['qr_code', 'ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'itf'] });
    escFlujo = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } }, audio: false });
    const v = $('esc-video');
    v.srcObject = escFlujo;
    await v.play();
    $('esc-estado').textContent = 'Buscando un código…';
    escBucle = setInterval(mirarCamara, 350);
  } catch (e) {
    sinEscaner(String(e.name) === 'NotAllowedError'
      ? 'No diste permiso para la cámara. Búscalo en el candado de la barra de direcciones.'
      : 'No se pudo abrir la cámara.\n\n' + e.message +
        (location.protocol === 'https:'
          ? ''
          : '\n\nEntraste por http:// y el navegador bloquea la cámara ahí. Entra por ' +
            'https:// (la misma dirección con la «s»). Si sale un aviso rojo, este dispositivo ' +
            'todavía no tiene el sello del negocio: está en Ajustes.'));
  }
}

function sinEscaner(msg) {
  $('esc-estado').textContent = msg;
  $('esc-estado').style.whiteSpace = 'pre-line';
  const c = document.querySelector('.camara');
  if (c) c.style.display = 'none';
}

function cerrarEscaner() {
  if (escBucle) { clearInterval(escBucle); escBucle = null; }
  if (escFlujo) { escFlujo.getTracks().forEach(t => t.stop()); escFlujo = null; }
  const c = document.querySelector('.camara');
  if (c) c.style.display = '';
  $('velo-escaner').classList.remove('abierto');
}

let ultimoLeido = '', ultimoCuando = 0;
async function mirarCamara() {
  const v = $('esc-video');
  if (!v || !escDetector || v.readyState < 2) return;
  let codigos;
  try { codigos = await escDetector.detect(v); } catch (e) { return; }
  if (!codigos || !codigos.length) return;
  const valor = String(codigos[0].rawValue || '').trim();
  if (!valor) return;
  // Un código se queda delante de la cámara varios fotogramas: sin esto se
  // añadirían diez unidades por acercar el producto una vez.
  const ahora = Date.now();
  if (valor === ultimoLeido && ahora - ultimoCuando < 2000) return;
  ultimoLeido = valor; ultimoCuando = ahora;
  if (navigator.vibrate) navigator.vibrate(60);
  usarCodigoLeido(valor);
}

function usarCodigoLeido(valor) {
  if (escDesde === 'ficha') {
    $('f-codbarra').value = valor;
    $('esc-estado').textContent = '✓ ' + valor;
    toast('✓ Código guardado en la ficha');
    setTimeout(cerrarEscaner, 500);
    return;
  }
  const p = productosAqui().find(x =>
    (String(x.codigo_barra || '') === valor || String(x.codigo || '') === valor));
  if (p) {
    alCarro(p.id);
    $('esc-estado').textContent = '✓ ' + p.nombre;
    $('esc-hallado').innerHTML = '';
    return;
  }
  // Código desconocido: en vez de un "no encontrado" seco, se ofrece
  // engancharlo a un producto. Así el catálogo se va enseñando solo.
  $('esc-estado').textContent = 'Código no reconocido: ' + valor;
  $('esc-hallado').innerHTML = `<div class="aviso">
      <b>${esc(valor)}</b> no está en ningún producto.<br>
      Búscalo abajo y quedará enganchado para siempre.
      <input type="search" id="esc-busq" placeholder="Buscar producto…" style="margin-top:9px">
      <div id="esc-res"></div>
    </div>`;
  $('esc-busq').addEventListener('input', () => {
    const q = ($('esc-busq').value || '').trim().toLowerCase();
    $('esc-res').innerHTML = !q ? '' : productosAqui().filter(x =>
      x.nombre.toLowerCase().includes(q)).slice(0, 5).map(x =>
      `<div class="prod" onclick="engancharCodigo('${x.id}','${esc(valor)}')">
         <span class="cod">${esc(x.codigo)}</span>
         <div class="info"><div class="nm">${esc(x.nombre)}</div></div>
       </div>`).join('');
  });
  $('esc-busq').focus();
}

async function engancharCodigo(id, valor) {
  const p = PRODUCTOS.find(x => x.id === id);
  if (!p) return;
  try {
    await api('/api/productos/' + id, { method: 'PUT', body: JSON.stringify(
      Object.assign({}, p, { codigo_barra: valor,
        precios: (p.precios || []).map(x => ({ sitio_id: x.sitio_id, precio: x.precio })) })) });
    await cargarCatalogo();
    $('esc-hallado').innerHTML = '';
    $('esc-estado').textContent = '✓ ' + valor + ' → ' + p.nombre;
    toast('✓ Enganchado. La próxima vez se reconoce solo.');
    alCarro(id);
  } catch (e) { alert('No se pudo guardar: ' + e.message); }
}

// ═══════════════════════════════════════════════════════════════
//  CONTADOR DE BILLETES
// ═══════════════════════════════════════════════════════════════
// Contar a mano y teclear un total es como se cuelan los errores de caja. Aquí
// se pone cuántos billetes hay de cada valor y la suma la hace la máquina.

let DENOMS = { CUP: [1, 3, 5, 10, 20, 50, 100, 200, 500, 1000], USD: [1, 5, 10, 20, 50, 100] };
let ctMoneda = 'CUP';
let ctDesde = 'caja';          // de dónde se abrió: 'caja' o 'cierre'
const ctCuenta = { CUP: {}, USD: {} };

async function cargarDenominaciones() {
  try {
    const d = await api('/api/denominaciones');
    if (d && d.CUP && d.USD) DENOMS = d;
  } catch (e) {}
}

function abrirContador(desde) {
  ctDesde = desde || 'caja';
  ctMoneda = desde === 'caja' ? MONEDA : 'CUP';
  document.querySelectorAll('#velo-contador .pestanas button').forEach(b =>
    b.classList.toggle('activa', b.textContent.trim() === ctMoneda));
  $('ct-den-cup').value = DENOMS.CUP.join(', ');
  $('ct-den-usd').value = DENOMS.USD.join(', ');
  $('ct-usar').textContent = ctDesde === 'cierre' ? 'Usar en el cierre' : 'Listo';
  renderContadorBilletes();
  $('velo-contador').classList.add('abierto');
}
function cerrarContador() { $('velo-contador').classList.remove('abierto'); }

function monedaContador(m, btn) {
  ctMoneda = m;
  document.querySelectorAll('#velo-contador .pestanas button').forEach(b => b.classList.remove('activa'));
  if (btn) btn.classList.add('activa');
  renderContadorBilletes();
}

function ponerBilletes(valor, n) {
  ctCuenta[ctMoneda][valor] = Math.max(0, parseInt(n, 10) || 0);
  renderContadorBilletes();
}
function limpiarContador() { ctCuenta[ctMoneda] = {}; renderContadorBilletes(); }

function totalContador(m) {
  const c = ctCuenta[m] || {};
  return Object.keys(c).reduce((s, v) => s + Number(v) * c[v], 0);
}

function renderContadorBilletes() {
  const c = ctCuenta[ctMoneda] || {};
  $('ct-lista').innerHTML = (DENOMS[ctMoneda] || []).map(v => {
    const n = c[v] || 0;
    return `<div class="linea">
      <div class="nm">${dinero(v, ctMoneda)}${n ? '<small>' + n + ' × ' + v + ' = ' +
        dinero(v * n, ctMoneda) + '</small>' : ''}</div>
      <div class="cant">
        <button onclick="ponerBilletes(${v}, ${n - 1})">−</button>
        <input type="number" inputmode="numeric" value="${n || ''}" placeholder="0"
               onchange="ponerBilletes(${v}, this.value)">
        <button onclick="ponerBilletes(${v}, ${n + 1})">+</button>
      </div>
      <div class="imp">${n ? dinero(v * n, ctMoneda) : ''}</div>
    </div>`;
  }).join('');
  const t = totalContador(ctMoneda);
  $('ct-total').textContent = dinero(t, ctMoneda);
  // En la caja, comparar con lo que hay que cobrar y decir la vuelta
  let nota = '';
  if (ctDesde === 'caja' && CARRO.length && ctMoneda === MONEDA) {
    const debe = totalCarro();
    const dif = t - debe;
    nota = dif >= 0
      ? 'La venta es de ' + dinero(debe, MONEDA) + '. Vuelto: <b>' + dinero(dif, MONEDA) + '</b>'
      : 'La venta es de ' + dinero(debe, MONEDA) + '. Faltan <b>' + dinero(-dif, MONEDA) + '</b>';
  } else if (ctDesde === 'cierre') {
    nota = 'Al darle a «Usar en el cierre» se copia en el efectivo contado de ' + ctMoneda + '.';
  }
  $('ct-nota').innerHTML = nota;
}

function usarContador() {
  if (ctDesde === 'cierre') {
    $('ci-efectivo').value = totalContador('CUP') || '';
    $('ci-transfer').value = totalContador('USD') || '';
    if (typeof compararCaja === 'function') compararCaja();
    toast('✓ Copiado al cierre');
  }
  cerrarContador();
}

async function guardarDenominaciones() {
  const leer = t => (t || '').split(/[,;\s]+/).map(Number).filter(n => n > 0);
  const cup = leer($('ct-den-cup').value), usd = leer($('ct-den-usd').value);
  if (!cup.length || !usd.length) { toast('⚠ Cada moneda necesita al menos un valor'); return; }
  try {
    const r = await api('/api/denominaciones', { method: 'POST',
      body: JSON.stringify({ CUP: cup, USD: usd }) });
    DENOMS = { CUP: r.CUP, USD: r.USD };
    renderContadorBilletes();
    toast('✓ Denominaciones guardadas');
  } catch (e) { alert('No se pudo guardar: ' + e.message); }
}

// ─── Cobro ────────────────────────────────────────────────────
// ─── Los clientes ─────────────────────────────────────────────
// Se cargan con el catálogo y se quedan en el dispositivo, como todo lo demás: la
// aplicación tiene que poder fiarle a alguien sin internet.
async function cargarClientes() {
  if (!puedo('ver_clientes')) { CLIENTES = []; return; }
  try {
    const d = await api('/api/clientes');
    CLIENTES = d.clientes || [];
  } catch (e) { /* sin permiso o sin conexión: se vende igual, al contado */ }
  pintarSelectorClientes();
}

function pintarSelectorClientes() {
  const sel = $('cobro-cliente');
  if (!sel) return;
  const antes = sel.value;
  sel.innerHTML = '<option value="">Sin cliente — venta de mostrador</option>' +
    CLIENTES.map(c => `<option value="${c.id}">${esc(c.nombre)}${
      c.telefono ? ' · ' + esc(c.telefono) : ''}</option>`).join('');
  sel.value = antes;
}

// Cómo paga: entera, una parte, o nada todavía. Vive aquí y no en el servidor
// porque es una pregunta de la pantalla; lo que se manda es un número.
let FORMA_COBRO = 'todo';

function ponerFormaCobro(cual, btn) {
  FORMA_COBRO = cual;
  const caja = $('cobro-formas');
  if (caja) caja.querySelectorAll('button').forEach(b => b.classList.remove('activa'));
  if (btn) btn.classList.add('activa');
  $('cobro-parte').style.display = cual === 'parte' ? 'block' : 'none';
  if (cual === 'parte') setTimeout(() => $('cobro-entrega').focus(), 60);
  pintarFormaCobro();
}

// Lo que entrega ahora, según la forma elegida. Un solo sitio que lo decida: dos
// cuentas parecidas repartidas por la pantalla acaban no coincidiendo.
function entregaAhora() {
  const total = totalCarro();
  if (FORMA_COBRO === 'todo') return total;
  if (FORMA_COBRO === 'nada') return 0;
  const x = parseFloat($('cobro-entrega').value) || 0;
  return Math.max(0, Math.min(x, total));
}

function pintarFormaCobro() {
  const total = totalCarro(), entrega = entregaAhora(), debe = total - entrega;
  const sinCliente = !$('cobro-cliente').value;
  // El aviso dice lo que va a pasar ANTES de pulsar, no después de que el
  // servidor se niegue: quien está en el mostrador tiene al cliente delante.
  $('cobro-debe').innerHTML = debe <= 0.005 ? ''
    : (sinCliente
      ? '<b style="color:var(--rojo)">Quedan ' + dinero(debe, MONEDA) + ' a deber, y hace ' +
        'falta decir de qué cliente es:</b> una deuda sin cliente no se le puede cobrar a nadie.'
      : 'Se lleva la mercancía y queda a deber <b>' + dinero(debe, MONEDA) + '</b>. Ese ' +
        'dinero <b>no entra en la caja</b> hasta que lo traiga.');
  const btn = $('btn-confirmar');
  if (btn) btn.textContent = debe <= 0.005 ? 'Confirmar venta'
    : (entrega > 0.005 ? 'Cobrar ' + dinero(entrega, MONEDA) + ' y fiar el resto'
                       : 'Fiar la venta entera');
}

function abrirCobro() {
  if (!CARRO.length) return;
  $('cobro-total').textContent = dinero(totalCarro(), MONEDA);
  const uds = CARRO.reduce((s, l) => s + l.cantidad, 0);
  $('cobro-detalle').textContent =
    CARRO.length + (CARRO.length === 1 ? ' producto' : ' productos') + ', ' +
    uds + (uds === 1 ? ' unidad' : ' unidades');
  pintarSelectorClientes();
  $('cobro-cliente').value = '';
  $('cobro-entrega').value = '';
  // Cada venta empieza en «paga todo»: es lo que pasa casi siempre, y dejar
  // puesta la forma de la venta anterior sería fiarle sin querer al siguiente.
  ponerFormaCobro('todo', $('cobro-formas') && $('cobro-formas').querySelector('button'));
  // Con el candado puesto (DECISIONES.md #6) no se cobra lo que no está: el
  // botón se apaga y se dice qué hacer. Sin él, se avisa y se deja pasar.
  const faltan = CARRO.filter(l => l.cantidad > Number(STOCK[l.producto_id] || 0));
  $('btn-confirmar').disabled = faltan.length > 0 && !VENDER_SIN_STOCK;
  $('cobro-aviso').innerHTML = !faltan.length ? '' : (VENDER_SIN_STOCK
    ? `<div class="aviso"><b>Ojo:</b> de ${faltan.map(f => esc(f.nombre)).join(', ')} vas a
        vender más de lo que dice el inventario. La venta se registra igual, pero el stock
        quedará en negativo y conviene revisar qué pasó.</div>`
    : `<div class="aviso"><b>No se puede cobrar.</b> De
        ${faltan.map(f => esc(f.nombre) + ' quedan ' + (Number(STOCK[f.producto_id]) || 0)).join('; ')}.
        Si la mercancía llegó y no se apuntó, regístrala como entrada en el Almacén y
        vuelve a cobrar.</div>`);
  $('velo-cobro').classList.add('abierto');
}

function cerrarCobro() { $('velo-cobro').classList.remove('abierto'); }

async function confirmarVenta() {
  const btn = $('btn-confirmar');
  btn.disabled = true;
  try {
    const r = await api('/api/ventas', {
      method: 'POST',
      body: JSON.stringify({
        sitio_id: sitioActual(),
        moneda: MONEDA,
        cliente_id: $('cobro-cliente').value || null,
        // Lo que entrega AHORA. Se manda siempre, también cuando paga todo: así
        // el servidor no tiene que adivinar nada y la venta de mostrador sigue
        // siendo una venta con su cobro, como todas.
        cobrado_ahora: entregaAhora(),
        fecha: new Date().toLocaleDateString('sv-SE'),   // AAAA-MM-DD del dispositivo
        lineas: CARRO.map(l => ({ producto_id: l.producto_id, cantidad: l.cantidad }))
      })
    });
    CARRO = [];
    guardarCarro();
    cerrarCobro();
    await cargarStock();
    renderCarro();
    toast(r.falta > 0.005
      ? '✓ Venta de ' + dinero(r.total, r.moneda || MONEDA) + ' · quedan ' +
        dinero(r.falta, r.moneda || MONEDA) + ' a deber'
      : '✓ Venta de ' + dinero(r.total, r.moneda || MONEDA));
    // Si esa venta acaba de dejar algo bajo mínimo, el aviso sale AHORA, que es
    // cuando sirve de algo: quien está en el mostrador puede apuntarlo antes de
    // que se le olvide. Esperar al repaso de cada tres minutos sería avisar
    // cuando ya se fue el cliente.
    cargarAvisos();
    $('caja-busq').focus();
  } catch (e) {
    alert('No se pudo registrar la venta: ' + e.message);
  } finally { btn.disabled = false; }
}

// ═══════════════════════════════════════════════════════════════
//  EL DÍA: cuadre y cierre
// ═══════════════════════════════════════════════════════════════
// Aquí no hay ningún inventario que arrastrar de un día al siguiente: el stock
// de mañana es la suma de los movimientos hasta mañana. El arrastre no puede
// fallar porque no existe (DECISIONES.md #1).

let DIA = null;
let TEORICO = {};
let CONTEO = [];   // [{producto_id, nombre, codigo, contado}]

function fechaDia() {
  return $('dia-fecha').value || new Date().toLocaleDateString('sv-SE');
}

async function cargarDia() {
  if (!$('dia-fecha').value) $('dia-fecha').value = new Date().toLocaleDateString('sv-SE');
  const f = fechaDia();
  try {
    DIA = await api('/api/dia?sitio_id=' + encodeURIComponent(sitioActual()) + '&fecha=' + f);
  } catch (e) { DIA = null; return; }

  const v = DIA.ventas;
  $('v-cuenta').textContent = v.cuenta;
  $('v-total').textContent = dinero(v.por_moneda.CUP, 'CUP') +
    (v.por_moneda.USD ? '  +  ' + dinero(v.por_moneda.USD, 'USD') : '');
  $('v-efectivo').textContent = dinero(v.por_moneda.CUP, 'CUP');
  $('v-transf').textContent = dinero(v.por_moneda.USD, 'USD');
  // Lo vendido, el costo y la ganancia van en la moneda del NEGOCIO: el
  // efectivo de arriba es lo que entró en cada caja, esto es cómo va el mes.
  $('v-vendido').textContent = enBase(v.total) +
    (v.sin_tasa ? ' (falta el valor del dólar para alguna venta)' : '');
  $('v-costo').textContent = v.costo === null ? '—' : enBase(v.costo);
  $('v-ganancia').textContent = v.ganancia === null ? '—' : conRef(v.ganancia);
  $('v-comision').textContent = enBase(v.comision);
  // Lo que cuesta la gente. Quien no puede ver ganancias recibe null y aquí no
  // se enseña nada: el servidor no le manda las cifras, no es que se escondan.
  const per = DIA.personal;
  $('v-sueldos').textContent = per ? enBase(per.sueldos) : '—';
  $('v-queda').textContent = per ? enBase(per.queda) : '—';
  $('v-mermas').textContent = enBase(DIA.mermas.valor);
  $('v-compras').textContent = enBase(DIA.compras.valor);
  $('v-traslados').textContent = DIA.traslados.salidas + ' / ' + DIA.traslados.entradas;

  const dif = DIA.conteos_con_diferencia || [];
  $('dia-estado').innerHTML = DIA.cerrado
    ? `<div class="tarjeta" style="border-color:var(--marca-claro)">
         <div class="fila" style="border:0;padding:0">
           <span><b>Día cerrado</b><br><span style="font-size:12px;color:var(--texto3)">
             ${new Date(DIA.dia.cerrado_en).toLocaleString('es-CU')}</span></span>
           <button class="acc" style="color:var(--texto2)" onclick="reabrirDia()">Reabrir</button>
           ${puedo('gente_del_dia') ? '<button class="acc" style="color:var(--texto2)" ' +
             'onclick="abrirCierre(true)">Quién trabajó</button>' : ''}
         </div>
         ${dif.length ? `<div class="aviso" style="margin-top:10px"><b>Descuadres del conteo:</b><br>` +
            dif.map(c => esc(c.nombre) + ': contaste ' + c.contado + ', debía haber ' + c.teorico +
              ' (' + (c.contado - c.teorico > 0 ? '+' : '') + (c.contado - c.teorico) + ')').join('<br>') +
            '</div>' : ''}
       </div>`
    : '';
  $('btn-cerrar-dia').style.display = DIA.cerrado ? 'none' : 'flex';

  // En el almacén principal, debajo del cuadre de la jornada va la jornada del
  // NEGOCIO ENTERO, sitio por sitio. Arriba sigue estando lo de aquí: son dos
  // cosas distintas y el almacén también tiene que poder cuadrar lo suyo.
  if (enElMirador()) {
    try {
      NEGOCIO = await api('/api/negocio?desde=' + f + '&hasta=' + f);
      $('dia-negocio').innerHTML = bloquePorSitio();
    } catch (e) { $('dia-negocio').innerHTML = ''; }
  } else $('dia-negocio').innerHTML = '';

  await cargarVentas();
}

async function reabrirDia() {
  if (!confirm('¿Reabrir la jornada del ' + fechaDia() + '?\n\nQuedará anotado que se reabrió: ' +
               'no es lo mismo un día que nunca se cerró que uno que se cerró y se volvió a abrir.')) return;
  try {
    await api('/api/dias/reabrir', { method: 'POST', body: JSON.stringify({
      sitio_id: sitioActual(), fecha: fechaDia() }) });
    toast('✓ Día reabierto');
    await cargarDia();
  } catch (e) { alert('No se pudo reabrir: ' + e.message); }
}

// ═══════════════════════════════════════════════════════════════
//  RESÚMENES POR PERÍODO Y EXPORTACIÓN A PDF
// ═══════════════════════════════════════════════════════════════
// El PDF lo hace el propio navegador (Imprimir → Guardar como PDF). Meter una
// librería de PDF significaría cargarla de internet, y la app tiene que
// funcionar sin conexión (DECISIONES.md #8). Además así el documento se ve
// exactamente como se guarda.

let RESUMEN = null;
let NEGOCIO = null;        // el desglose por sitio, cuando se miran todos
let FONDO = null;          // lo último que contestó /api/fondo

// El ALMACÉN PRINCIPAL es el mirador del negocio: quien está allí es quien
// lleva las cuentas de todo, y lo que quiere ver de entrada es el conjunto.
// Quien está en un punto ve lo suyo, que es de lo que responde. Sigue siendo un
// desplegable: esto es con qué empieza, no lo único que se puede mirar.
// Cuál es el almacén principal se decide igual que en el servidor —el primer
// almacén que se creó—, no por el nombre ni por un identificador escrito a
// mano: aquí hay tres almacenes (Principal, Iglesia y Brigada) y si cada lado
// eligiera uno distinto, la mercancía sin repartir de una inversión entraría en
// un sitio y se enseñaría en otro.
const sitioPrincipal = () => (SITIOS
  .filter(s => s.tipo === 'almacen' && s.activo !== 0)
  .sort((a, b) => (a.creado_en || '') < (b.creado_en || '') ? -1 : 1)[0] || {}).id;
const enElMirador = () => sitioActual() === sitioPrincipal();

function pestanaInforme(cual, btn) {
  document.querySelectorAll('#p-ventas .pestanas button').forEach(b => b.classList.remove('activa'));
  if (btn) btn.classList.add('activa');
  $('t-dia').style.display = cual === 'dia' ? 'block' : 'none';
  $('t-periodo').style.display = cual === 'periodo' ? 'block' : 'none';
  if (cual === 'periodo') {
    if (!$('rs-sitio').options.length) {
      // «Todos los sitios» solo se ofrece a quien puede verlos todos; a los demás,
      // ese «todos» es el suyo y ya sale sin elegir nada (decisión #39).
      const suyos = misSitios();
      $('rs-sitio').innerHTML = (suyos.length === SITIOS.length
        ? '<option value="">Todos los sitios</option>' : '') +
        suyos.map(s => `<option value="${s.id}">${esc(s.nombre)}</option>`).join('');
      $('rs-sitio').value = enElMirador() && suyos.length === SITIOS.length ? '' : sitioActual();
    }
    cargarResumen();
  }
}

function rangoElegido() {
  $('rs-fechas').style.display = $('rs-rango').value === 'libre' ? 'flex' : 'none';
  if ($('rs-rango').value === 'libre' && !$('rs-desde').value) {
    const hoy = new Date().toLocaleDateString('sv-SE');
    $('rs-desde').value = hoy.slice(0, 8) + '01';
    $('rs-hasta').value = hoy;
  }
  cargarResumen();
}

function rangoFechas() {
  const hoy = new Date();
  const iso = d => d.toLocaleDateString('sv-SE');
  const h = iso(hoy);
  switch ($('rs-rango').value) {
    case 'hoy': return { desde: h, hasta: h };
    case 'semana': return { desde: iso(new Date(hoy - 6 * 86400000)), hasta: h };
    case 'mes': return { desde: h.slice(0, 8) + '01', hasta: h };
    case 'mespasado': {
      const p = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
      const u = new Date(hoy.getFullYear(), hoy.getMonth(), 0);
      return { desde: iso(p), hasta: iso(u) };
    }
    case 'anio': return { desde: h.slice(0, 4) + '-01-01', hasta: h };
    default: return { desde: $('rs-desde').value || '2000-01-01',
                      hasta: $('rs-hasta').value || h };
  }
}

async function cargarResumen() {
  const r = rangoFechas();
  const sitio = $('rs-sitio').value;
  try {
    // Sin sitio elegido se pide además el desglose del negocio entero. Van los
    // dos a la vez: son dos preguntas independientes y encadenarlas solo haría
    // esperar el doble.
    const [res, neg] = await Promise.all([
      api('/api/resumen?desde=' + r.desde + '&hasta=' + r.hasta +
          (sitio ? '&sitio_id=' + encodeURIComponent(sitio) : '')),
      sitio ? null : api('/api/negocio?desde=' + r.desde + '&hasta=' + r.hasta).catch(() => null)
    ]);
    RESUMEN = res;
    NEGOCIO = neg;
  } catch (e) {
    $('rs-contenido').innerHTML = '<div class="vacio">' + esc(e.message) + '</div>';
    return;
  }
  const d = RESUMEN, v = d.ventas, g = d.ver_ganancias;
  const fila = (k, val, fuerte) => `<div class="fila"${fuerte ? ' style="font-weight:700"' : ''}>
    <span>${k}</span><b class="num">${val}</b></div>`;

  // El efectivo que entró, por moneda. Los pesos y los dólares NO se suman
  // (DECISIONES.md #21): lo de arriba es la medida del negocio en una sola
  // moneda, y esto es el dinero que hay que contar en la caja.
  const cobrado = Object.entries(v.por_moneda || {})
    .filter(([, x]) => x)
    .map(([m, x]) => `<div class="fila"><span style="padding-left:12px;color:var(--texto3)">—
      cobrado en ${esc(m)}</span><b class="num">${dinero(x, m)}</b></div>`).join('');

  const nombreTipo = { retiro: 'Retiros', inversion: 'Inversiones', gasto: 'Gastos' };
  const fondoPorTipo = {};
  (d.fondo || []).forEach(f => { (fondoPorTipo[f.tipo] = fondoPorTipo[f.tipo] || []).push(f); });
  const bloqueFondo = ['retiro', 'inversion', 'gasto'].map(t =>
    ['CUP', 'USD'].map(m => {
      const l = (fondoPorTipo[t] || []).filter(x => (x.moneda || 'CUP') === m);
      if (!l.length) return '';
      const tot = l.reduce((s, x) => s + x.total, 0);
      return `<div class="fila"><span>${nombreTipo[t]}
        <br><span style="font-size:11px;color:var(--texto3)">${l.map(x =>
          esc(x.subtipo || 'sin tipo') + ' ' + dinero(x.total, m)).join(' · ')}</span></span>
        <b class="num">${dinero(tot, m)}</b></div>`;
    }).join('')).join('');

  $('rs-contenido').innerHTML = `
    <div class="tarjeta" style="text-align:center">
      <h2>${esc(d.sitio)} · ${esc(d.desde)} a ${esc(d.hasta)}</h2>
      <div class="grande">${enBase(v.total)}</div>
      <div class="pista" style="text-align:center">${v.cuenta} ventas${
        d.dias_cerrados ? ' · ' + d.dias_cerrados + ' día(s) cerrado(s)' : ''}</div>
    </div>

    <div class="tarjeta">
      <h2>Ingresos y gastos</h2>
      ${fila('Ventas', enBase(v.total))}
      ${cobrado}
      ${g ? fila('Costo de lo vendido', enBase(v.costo)) : ''}
      ${g ? fila('Ganancia bruta', conRef(v.ganancia), true) : ''}
      ${fila('− Comisión de vendedores', enBase(v.comision))}
      ${g && d.personal ? fila('− Salarios y adelantos', enBase(d.personal.sueldos)) : ''}
      ${g && d.personal ? fila('Queda después del personal', conRef(d.personal.queda), true) : ''}
      ${g ? fila('Mermas', enBase(d.mermas.valor)) : ''}
      ${g ? fila('Entradas de mercancía', enBase(d.compras.valor)) : ''}
      ${bloqueFondo}
    </div>

    ${bloquePorSitio()}

    <div class="tarjeta">
      <h2>Día a día</h2>
      ${d.por_dia.length ? `<div class="tablaCont"><table class="tabla">
        <thead><tr><th>Fecha</th><th class="n">Ventas</th><th class="n">Cobrado</th>
          ${g ? '<th class="n">Ganancia</th>' : ''}</tr></thead>
        <tbody>${d.por_dia.map(x => `<tr><td>${esc(x.fecha)}</td><td class="n">${x.cuenta}</td>
          <td class="n">${enBase(x.total)}</td>
          ${g ? '<td class="n">' + enBase(x.total - x.costo) + '</td>' : ''}</tr>`).join('')}</tbody>
      </table></div>` : '<div class="vacio">Sin ventas en este período.</div>'}
    </div>

    <div class="tarjeta">
      <h2>Lo más vendido</h2>
      ${d.top_productos.length ? `<div class="tablaCont"><table class="tabla">
        <thead><tr><th>Producto</th><th class="n">Uds.</th><th class="n">Vendido</th>
          ${g ? '<th class="n">Ganancia</th>' : ''}</tr></thead>
        <tbody>${d.top_productos.map(p => `<tr><td>${esc(p.nombre)}
          <br><span style="font-size:10.5px;color:var(--texto3)">${esc(p.codigo)}</span></td>
          <td class="n">${Math.round(p.unidades)}</td><td class="n">${enBase(p.total)}</td>
          ${g ? '<td class="n">' + enBase(p.ganancia) + '</td>' : ''}</tr>`).join('')}</tbody>
      </table></div>` : '<div class="vacio">Nada vendido todavía.</div>'}
    </div>`;
}

// ─── Todo el negocio, sitio por sitio ─────────────────────────
// Dos tablas y no una, y esto es lo importante de esta pantalla: arriba lo que
// PASÓ entre dos fechas (un flujo) y abajo lo que HAY hoy (un saldo). Son dos
// preguntas distintas y juntarlas en una sola tabla es la forma más rápida de
// que alguien lea «tiene 90 000» donde pone «vendió 90 000».
function bloquePorSitio() {
  const n = NEGOCIO;
  if (!n || !n.sitios || !n.sitios.length) return '';
  const g = n.ver_ganancias;
  const conMovimiento = p => p.ventas || p.mermas.unidades || p.entradas.unidades ||
    p.traslados.salieron || p.traslados.entraron ||
    (p.fondo && ['CUP', 'USD'].some(m => ['retiro', 'inversion', 'gasto', 'ingreso']
      .some(t => p.fondo[m][t])));
  const filas = n.sitios.filter(conMovimiento);
  // Quien solo ve su local recibe una sola fila, y el total es el de esa fila.
  // Llamarlo «total de la empresa» seria decirle que el negocio entero es lo suyo.
  const verTodo = n.ver_todo !== false;
  const rotuloTotal = verTodo ? 'TOTAL DE LA EMPRESA'
    : filas.length > 1 ? 'TOTAL DE TUS LOCALES' : 'TOTAL';
  // OJO con el nombre: el servidor manda 'gaveta', que es como se llama el dato
  // desde el 13 de agosto de 2026. En la pantalla la palabra es «caja», pero eso
  // es lo que LEE el dueño, no el nombre del campo. Cambiarlo aquí sin cambiarlo
  // allí dejó «Detalle por sitio» y «Lo que hay ahora» en blanco (ver la nota de
  // arriba del archivo y DECISIONES.md #21).
  const conCosas = p => p.inventario.unidades || (p.gaveta &&
    (p.gaveta.CUP || p.gaveta.USD));
  const tienen = n.sitios.filter(conCosas);

  // Lo que salió del fondo, sumado POR MONEDA. Los pesos se suman con los pesos
  // y los dólares con los dólares, nunca entre ellos (DECISIONES.md #21). En la
  // primera versión salía una cifra por cada tipo y el total decía «50 000 CUP ·
  // 3 000 CUP», que hay que sumar de cabeza para saber qué salió.
  const salidas = p => ['CUP', 'USD'].map(m => {
    const t = p.fondo ? ['retiro', 'inversion', 'gasto']
      .reduce((s, k) => s + (p.fondo[m][k] || 0), 0) : 0;
    return t ? dinero(t, m) : '';
  }).filter(Boolean).join(' · ') || '—';

  return `
    <div class="tarjeta">
      <h2>Lo que se movió, por sitio</h2>
      ${filas.length ? `<div class="tablaCont"><table class="tabla">
        <thead><tr><th>Sitio</th><th class="n">Vendido</th>
          ${g ? '<th class="n">Ganancia</th><th class="n">Mermas</th><th class="n">Entradas</th>' : ''}
          <th class="n">Salió del fondo</th></tr></thead>
        <tbody>${filas.map(p => `<tr>
          <td>${esc(p.sitio)}${(() => {
            const partes = [];
            if (p.ventas) partes.push(p.ventas + (p.ventas === 1 ? ' venta' : ' ventas'));
            if (p.traslados.salieron) partes.push('salieron ' + Math.round(p.traslados.salieron) + ' u.');
            if (p.traslados.entraron) partes.push('entraron ' + Math.round(p.traslados.entraron) + ' u.');
            return partes.length ? '<br><span style="font-size:10.5px;color:var(--texto3)">' +
              partes.join(' · ') + '</span>' : '';
          })()}</td>
          <td class="n">${p.tipo === 'negocio' ? '—' : enBase(p.vendido)}</td>
          ${g ? ['ganancia', 'mermas', 'entradas'].map(c => `<td class="n">${
                 p.tipo === 'negocio' ? '—'
                   : enBase(c === 'ganancia' ? p.ganancia : p[c].valor)}</td>`).join('') : ''}
          <td class="n">${salidas(p)}</td></tr>`).join('')}
          <tr style="font-weight:700"><td>${rotuloTotal}</td>
            <td class="n">${enBase(n.total.vendido)}</td>
            ${g ? `<td class="n">${enBase(n.total.ganancia)}</td>
                   <td class="n">${enBase(n.total.mermas.valor)}</td>
                   <td class="n">${enBase(n.total.entradas.valor)}</td>` : ''}
            <td class="n">${salidas(n.total)}</td></tr>
        </tbody></table></div>` : '<div class="vacio">Nada se movió en este período.</div>'}
      <div class="pista">Lo de esta tabla es ${n.desde === n.hasta
        ? 'lo del día ' + esc(n.desde) : 'lo que pasó entre las dos fechas de arriba'}.
        ${verTodo ? 'Los apuntes viejos que no son de ningún punto salen en la fila ' +
          '«Del negocio».' : 'Se te enseña lo de tu local; del resto de la empresa no.'}</div>
    </div>

    ${n.ver_dinero || g ? `<div class="tarjeta">
      <h2>Lo que hay ahora</h2>
      <div class="tablaCont"><table class="tabla">
        <thead><tr><th>Sitio</th>${n.ver_dinero ? '<th class="n">En la caja</th>' : ''}
          <th class="n">Mercancía</th></tr></thead>
        <tbody>${tienen.map(p => `<tr><td>${esc(p.sitio)}</td>
          ${n.ver_dinero && p.gaveta ? `<td class="n">${p.gaveta.CUP ? dinero(p.gaveta.CUP, 'CUP') : ''}${
            p.gaveta.CUP && p.gaveta.USD ? '<br>' : ''}${
            p.gaveta.USD ? dinero(p.gaveta.USD, 'USD') : ''}${
            !p.gaveta.CUP && !p.gaveta.USD ? '—' : ''}</td>` : n.ver_dinero ? '<td class="n">—</td>' : ''}
          <td class="n">${p.tipo === 'negocio' ? '—' : `${
            g ? enBase(p.inventario.valor) : Math.round(p.inventario.unidades) + ' u.'}${
            g ? '<br><span style="font-size:10.5px;color:var(--texto3)">' +
                Math.round(p.inventario.unidades) + ' u.</span>' : ''}`}</td></tr>`).join('')}
          <tr style="font-weight:700"><td>${rotuloTotal}</td>
            ${n.ver_dinero ? `<td class="n">${dinero((n.total.gaveta || {}).CUP || 0, 'CUP')}<br>${
              dinero((n.total.gaveta || {}).USD || 0, 'USD')}</td>` : ''}
            <td class="n">${g ? enBase(n.total.inventario.valor)
                              : Math.round(n.total.inventario.unidades) + ' u.'}</td></tr>
      </tbody></table></div>
      <div class="pista">Esto NO es del período: es lo que hay hoy mismo, contando desde el
        principio. La mercancía va al costo que se pagó.</div>
    </div>` : ''}`;
}

// ─── El documento que se imprime ──────────────────────────────
function cabeceraPDF(titulo, sub) {
  return `<div class="cab">
    <img src="${MARCA.logo || 'img/logo.png'}" alt="">
    <div><div class="t1">${esc(MARCA.nombre)}</div>
      <div class="t2">${esc(MARCA.lema)}${MARCA.lema ? ' · ' : ''}${esc(titulo)}</div>
      <div class="t2">${esc(sub)}</div></div>
  </div>`;
}
function piePDF() {
  return `<div class="pie"><span>Emitido el ${new Date().toLocaleString('es-CU')}${
    YO ? ' por ' + esc(YO.persona.nombre) : ''}</span><span>${esc(MARCA.nombre)}</span></div>`;
}
function lanzarImpresion(html) {
  $('impresion').innerHTML = html;
  // Un respiro para que el navegador pinte el logo antes de abrir el diálogo
  setTimeout(() => window.print(), 120);
}

function imprimirResumen() {
  if (!RESUMEN) { toast('⚠ Espera a que cargue el resumen'); return; }
  const d = RESUMEN, v = d.ventas, g = d.ver_ganancias;
  const kv = (k, x, f) => `<div class="kv${f ? ' fuerte' : ''}"><span>${k}</span><span>${x}</span></div>`;
  lanzarImpresion(
    cabeceraPDF('Resumen del período', d.sitio + ' · del ' + d.desde + ' al ' + d.hasta) +
    `<h2>Ingresos y gastos</h2>
     ${kv('Ventas (' + v.cuenta + ')', enBase(v.total))}
     ${Object.entries(v.por_moneda || {}).filter(([, x]) => x)
        .map(([m, x]) => kv('&nbsp;&nbsp;— cobrado en ' + m, dinero(x, m))).join('')}
     ${g ? kv('Costo de lo vendido', enBase(v.costo)) : ''}
     ${g ? kv('Ganancia bruta', conRef(v.ganancia), true) : ''}
     ${kv('− Comisión de vendedores', enBase(v.comision))}
     ${g && d.personal ? kv('− Salarios y adelantos', enBase(d.personal.sueldos)) : ''}
     ${g && d.personal ? kv('Queda después del personal', conRef(d.personal.queda), true) : ''}
     ${g ? kv('Mermas', enBase(d.mermas.valor)) : ''}
     ${g ? kv('Entradas de mercancía', enBase(d.compras.valor)) : ''}
     ${(d.fondo || []).filter(f => f.tipo !== 'ingreso').map(f =>
        kv(f.tipo + ' · ' + (f.subtipo || 'sin tipo'), dinero(f.total, f.moneda))).join('')}` +
    // El desglose por sitio va también en el papel: un informe que no dice lo
    // mismo que la pantalla desde la que se pidió es una trampa para quien lo
    // lea después.
    (NEGOCIO && NEGOCIO.sitios && NEGOCIO.sitios.length
      ? `<h2>Por sitio</h2><table class="saltar">
      <thead><tr><th>Sitio</th><th class="n">Ventas</th><th class="n">Vendido</th>
        ${g ? '<th class="n">Ganancia</th><th class="n">Mermas</th>' : ''}
        <th class="n">En la caja</th></tr></thead>
      <tbody>${NEGOCIO.sitios.map(p => `<tr><td>${esc(p.sitio)}</td>
        <td class="n">${p.ventas}</td><td class="n">${enBase(p.vendido)}</td>
        ${g ? '<td class="n">' + enBase(p.ganancia) + '</td><td class="n">' +
              enBase(p.mermas.valor) + '</td>' : ''}
        <td class="n">${!p.gaveta ? '—' : [p.gaveta.CUP ? dinero(p.gaveta.CUP, 'CUP') : '',
          p.gaveta.USD ? dinero(p.gaveta.USD, 'USD') : ''].filter(Boolean).join(' · ') || '—'}</td>
        </tr>`).join('')}</tbody>
      <tfoot><tr><td>Todo el negocio</td><td class="n">${NEGOCIO.total.ventas}</td>
        <td class="n">${enBase(NEGOCIO.total.vendido)}</td>
        ${g ? '<td class="n">' + enBase(NEGOCIO.total.ganancia) + '</td><td class="n">' +
              enBase(NEGOCIO.total.mermas.valor) + '</td>' : ''}
        <td class="n">${!NEGOCIO.total.gaveta ? '—'
          : [NEGOCIO.total.gaveta.CUP ? dinero(NEGOCIO.total.gaveta.CUP, 'CUP') : '',
             NEGOCIO.total.gaveta.USD ? dinero(NEGOCIO.total.gaveta.USD, 'USD') : '']
            .filter(Boolean).join(' · ') || '—'}</td></tr></tfoot></table>
      <div class="nota">Lo vendido y las mermas son del período. Lo de la caja no: es el
        dinero que hay en cada sitio hoy, contando desde el principio.</div>` : '') +
    (d.por_dia.length ? `<h2>Día a día</h2><table class="saltar">
      <thead><tr><th>Fecha</th><th class="n">Ventas</th><th class="n">Cobrado</th>
        ${g ? '<th class="n">Ganancia</th>' : ''}</tr></thead>
      <tbody>${d.por_dia.map(x => `<tr><td>${x.fecha}</td><td class="n">${x.cuenta}</td>
        <td class="n">${enBase(x.total)}</td>
        ${g ? '<td class="n">' + enBase(x.total - x.costo) + '</td>' : ''}</tr>`).join('')}</tbody>
      <tfoot><tr><td>Total</td><td class="n">${v.cuenta}</td><td class="n">${enBase(v.total)}</td>
        ${g ? '<td class="n">' + enBase(v.ganancia) + '</td>' : ''}</tr></tfoot></table>` : '') +
    (d.top_productos.length ? `<h2>Lo más vendido</h2><table class="saltar">
      <thead><tr><th>Código</th><th>Producto</th><th class="n">Uds.</th><th class="n">Vendido</th>
        ${g ? '<th class="n">Ganancia</th>' : ''}</tr></thead>
      <tbody>${d.top_productos.map(p => `<tr><td>${esc(p.codigo)}</td><td>${esc(p.nombre)}</td>
        <td class="n">${Math.round(p.unidades)}</td><td class="n">${enBase(p.total)}</td>
        ${g ? '<td class="n">' + enBase(p.ganancia) + '</td>' : ''}</tr>`).join('')}</tbody></table>` : '') +
    (g ? '' : '<div class="nota">Este resumen no incluye costos ni ganancias: tu cargo no tiene ese permiso.</div>') +
    piePDF());
}

// Lo que se exporta es LO QUE SE VE: si hay un filtro puesto o algo escrito en
// el buscador, el PDF sale con eso. Un informe que no coincide con la pantalla
// desde la que se pidió es una trampa para quien lo lee después.
function imprimirCatalogo() {
  const q = ($('busq').value || '').trim().toLowerCase();
  const cat = $('f-cat').value;
  let lista = productosDelApartado();
  if (cat) lista = lista.filter(p => p.categoria === cat);
  lista = deEsteLocal(lista);
  if (q) lista = lista.filter(p =>
    (p.nombre || '').toLowerCase().includes(q) || (p.codigo || '').toLowerCase().includes(q) ||
    (p.codigo_barra || '').toLowerCase().includes(q) || (p.categoria || '').toLowerCase().includes(q));
  lista.sort((a, b) => (a.categoria || '').localeCompare(b.categoria || '') ||
                       a.nombre.localeCompare(b.nombre));
  if (!lista.length) { toast('⚠ No hay productos que exportar'); return; }
  const verCosto = lista.some(p => p.costo !== null && p.costo !== undefined);
  const sitio = (SITIOS.find(s => s.id === sitioActual()) || {}).nombre || '';
  const filtro = [cat ? 'categoría ' + cat : '', nombreDelFiltroLocal(),
                  q ? '«' + q + '»' : ''].filter(Boolean).join(' · ');

  lanzarImpresion(
    cabeceraPDF('Catálogo de productos',
      lista.length + ' productos' + (filtro ? ' · ' + filtro : '') + ' · existencias de ' + sitio) +
    `<table><thead><tr><th>Código</th><th>Producto</th><th>Categoría</th>
       <th class="n">Precio</th>${verCosto ? '<th class="n">Costo</th>' : ''}
       <th class="n">Existencia</th></tr></thead><tbody>` +
    lista.map(p => `<tr><td>${esc(p.codigo)}</td><td>${esc(p.nombre)}${
        p.codigo_barra ? '<br><span style="font-size:8pt;color:#888">' + esc(p.codigo_barra) + '</span>' : ''}</td>
      <td>${esc(p.categoria || '—')}</td>
      <td class="n">${dinero(p.precio, p.precio_moneda || 'CUP')}</td>
      ${verCosto ? '<td class="n">' + enBase(p.costo || 0) + '</td>' : ''}
      <td class="n">${Math.round(Number(STOCK[p.id] || 0))} ${esc(p.um || '')}</td></tr>`).join('') +
    '</tbody></table>' +
    (verCosto ? '' : '<div class="nota">Sin los costos: tu cargo no tiene permiso para verlos.</div>') +
    piePDF());
}

function imprimirInventario() {
  const cat = $('alm-cat').value, filtro = $('alm-filtro').value;
  const q = ($('alm-busq').value || '').trim().toLowerCase();
  let lista = productosDelAlmacen();
  if (cat) lista = lista.filter(p => p.categoria === cat);
  if (q) lista = lista.filter(p => (p.nombre || '').toLowerCase().includes(q) ||
    (p.codigo || '').toLowerCase().includes(q));
  const hay = p => Number(STOCK[p.id] || 0);
  if (filtro === 'con') lista = lista.filter(p => hay(p) > 0);
  else if (filtro === 'bajo') lista = lista.filter(p => hay(p) <= (p.stock_min || 0));
  else if (filtro === 'negativo') lista = lista.filter(p => hay(p) < 0);
  lista.sort((a, b) => a.nombre.localeCompare(b.nombre));
  if (!lista.length) { toast('⚠ No hay nada que exportar con ese filtro'); return; }

  const sitio = (SITIOS.find(s => s.id === sitioActual()) || {}).nombre || '';
  const nombreFiltro = { con: 'con existencia', todos: 'todos los productos',
    bajo: 'stock bajo o agotado', negativo: 'en negativo' }[filtro] || '';
  let total = 0;
  const filas = lista.map(p => {
    const n = hay(p), v = n > 0 ? n * (p.costo || 0) : 0;
    total += v;
    return `<tr><td>${esc(p.codigo)}</td><td>${esc(p.nombre)}</td>
      <td class="n">${Math.round(n)}</td><td class="n">${enBase(p.costo || 0)}</td>
      <td class="n">${enBase(v)}</td></tr>`;
  }).join('');

  lanzarImpresion(
    cabeceraPDF('Inventario', sitio + ' · ' + nombreFiltro + ' · ' +
      new Date().toLocaleDateString('es-CU')) +
    `<table><thead><tr><th>Código</th><th>Producto</th><th class="n">Existencia</th>
       <th class="n">Costo</th><th class="n">Valor</th></tr></thead>
     <tbody>${filas}</tbody>
     <tfoot><tr><td colspan="4">Total (${lista.length} productos)</td>
       <td class="n">${conRef(total)}</td></tr></tfoot></table>
     <div class="nota">Valorado al costo pagado. La existencia sale de sumar todos los
       movimientos de este sitio hasta hoy.</div>` +
    `<div style="margin-top:26px;display:flex;gap:40px">
       <div style="flex:1;border-top:1px solid #666;padding-top:5px;font-size:9pt">Contado por</div>
       <div style="flex:1;border-top:1px solid #666;padding-top:5px;font-size:9pt">Revisado por</div>
     </div>` +
    piePDF());
}

async function imprimirFondo() {
  const r = rangoFondo();
  let d;
  try { d = await api('/api/fondo?desde=' + r.desde + '&hasta=' + r.hasta); }
  catch (e) { return alert('No se pudo preparar: ' + e.message); }
  const kv = (k, x, f) => `<div class="kv${f ? ' fuerte' : ''}"><span>${k}</span><span>${x}</span></div>`;
  const dos = campo => dinero(d.resumen.CUP[campo], 'CUP') +
    (d.resumen.USD[campo] ? '  +  ' + dinero(d.resumen.USD[campo], 'USD') : '');
  const neto = m => d.resumen[m].ingreso - d.resumen[m].retiro -
                    d.resumen[m].inversion - d.resumen[m].gasto;

  lanzarImpresion(
    cabeceraPDF('Fondo del negocio', 'Del ' + r.desde + ' al ' + r.hasta) +
    `<h2>Saldo actual</h2>
     ${kv('En pesos', dinero(d.saldo.CUP, 'CUP'), true)}
     ${kv('En dólares', dinero(d.saldo.USD, 'USD'), true)}
     <div class="nota">Las dos monedas van por separado: no se convierten. El saldo incluye
       el dinero de las ventas que sigue en la caja de cada punto.</div>
     <h2>En el período</h2>
     ${kv('Ingresos', dos('ingreso'))}
     ${kv('Retiros', dos('retiro'))}
     ${kv('Inversiones', dos('inversion'))}
     ${kv('Gastos', dos('gasto'))}
     ${kv('Saldo del período', dinero(neto('CUP'), 'CUP') +
        (neto('USD') ? '  +  ' + dinero(neto('USD'), 'USD') : ''), true)}` +
    (d.por_sitio.length ? '<h2>Ingresos por sitio</h2>' + d.por_sitio.map(x =>
      kv(esc(x.sitio), dinero(x.total, x.moneda))).join('') : '') +
    (d.movimientos.length ? `<h2>Movimientos</h2><table>
       <thead><tr><th>Fecha</th><th>Concepto</th><th>Tipo</th><th class="n">Importe</th></tr></thead>
       <tbody>${d.movimientos.map(m => `<tr><td>${esc(m.fecha)}</td>
         <td>${esc(m.concepto || m.subtipo || '—')}${m.sitio ? '<br><span style="font-size:8pt;color:#888">' + esc(m.sitio) + '</span>' : ''}</td>
         <td>${esc(m.tipo)}${m.subtipo ? ' · ' + esc(m.subtipo) : ''}</td>
         <td class="n">${m.tipo === 'ingreso' ? '+' : '−'}${dinero(Math.abs(m.importe), m.moneda)}</td>
       </tr>`).join('')}</tbody></table>` : '') +
    piePDF());
}

function imprimirCuadre() {
  if (!DIA) { toast('⚠ Espera a que cargue el día'); return; }
  const v = DIA.ventas, g = v.costo !== null;
  const sitio = (SITIOS.find(s => s.id === sitioActual()) || {}).nombre || '';
  const kv = (k, x, f) => `<div class="kv${f ? ' fuerte' : ''}"><span>${k}</span><span>${x}</span></div>`;
  const dif = DIA.conteos_con_diferencia || [];
  lanzarImpresion(
    cabeceraPDF('Cuadre de la jornada', sitio + ' · ' + DIA.fecha +
      (DIA.cerrado ? ' · CERRADO' : ' · sin cerrar')) +
    // El efectivo cobrado va por moneda; lo vendido, el costo y la ganancia van
    // en la moneda del negocio. Son dos cosas distintas y no se suman jamás
    // (DECISIONES.md #21).
    `<h2>Ventas</h2>
     ${kv('Número de ventas', v.cuenta)}
     ${Object.entries(v.por_moneda || {}).filter(([, x]) => x)
        .map(([m, x]) => kv('Cobrado en ' + m, dinero(x, m))).join('')}
     ${kv('Vendido', enBase(v.total))}
     ${g ? kv('Costo de lo vendido', enBase(v.costo)) : ''}
     ${g ? kv('Ganancia bruta', conRef(v.total - v.costo), true) : ''}
     ${kv('− Comisión de vendedores', enBase(v.comision))}
     ${g && DIA.personal ? kv('− Salarios y adelantos', enBase(DIA.personal.sueldos)) : ''}
     ${g && DIA.personal ? kv('Queda después del personal', conRef(DIA.personal.queda), true) : ''}
     <h2>Movimientos de mercancía</h2>
     ${g ? kv('Entradas', enBase(DIA.compras.valor)) : kv('Entradas (unidades)', DIA.compras.unidades)}
     ${g ? kv('Mermas', enBase(DIA.mermas.valor)) : kv('Mermas (unidades)', DIA.mermas.unidades)}
     ${kv('Traslados: salieron', DIA.traslados.salidas)}
     ${kv('Traslados: entraron', DIA.traslados.entradas)}` +
    (DIA.cerrado ? `<h2>Caja contada</h2>
       ${kv('Efectivo en pesos', dinero(DIA.dia.efectivo, 'CUP'))}
       ${kv('Efectivo en dólares', dinero(DIA.dia.efectivo_usd || 0, 'USD'))}
       ${kv('Transferencia', dinero(DIA.dia.transfer, 'CUP'))}
       ${kv('Total declarado en pesos', dinero(DIA.dia.efectivo + DIA.dia.transfer, 'CUP'), true)}
       ${DIA.dia.obs ? '<div class="nota">' + esc(DIA.dia.obs) + '</div>' : ''}` : '') +
    (dif.length ? `<h2>Descuadres del conteo</h2><table>
       <thead><tr><th>Producto</th><th class="n">Contado</th><th class="n">Debía haber</th>
         <th class="n">Diferencia</th></tr></thead>
       <tbody>${dif.map(c => `<tr><td>${esc(c.nombre)}</td><td class="n">${c.contado}</td>
         <td class="n">${c.teorico}</td>
         <td class="n">${c.contado - c.teorico > 0 ? '+' : ''}${c.contado - c.teorico}</td></tr>`).join('')}
       </tbody></table>` : '') +
    `<div style="margin-top:26px;display:flex;gap:40px">
       <div style="flex:1;border-top:1px solid #666;padding-top:5px;font-size:9pt">Entregado por</div>
       <div style="flex:1;border-top:1px solid #666;padding-top:5px;font-size:9pt">Recibido por</div>
     </div>` +
    piePDF());
}

// ─── Cierre ───────────────────────────────────────────────────
// soloGente: se abre para corregir únicamente la lista de quién trabajó. Es lo
// que hace falta cuando el día ya está cerrado y se olvidó marcar a alguien.
async function abrirCierre(soloGente) {
  const cerrado = !!(DIA && DIA.cerrado);
  soloGente = soloGente || cerrado;
  $('ci-titulo').textContent = soloGente ? 'Quiénes trabajaron' : 'Cerrar la jornada';
  $('ci-pista').innerHTML = soloGente
    ? 'La jornada del <b>' + esc(fechaDia()) + '</b> ya está cerrada. Cambiar esta lista no ' +
      'toca el inventario ni la caja: solo cambia entre cuántos se divide la comisión de ese día.'
    : 'Una vez cerrado, no se puede apuntar nada más con esa fecha: ni ventas, ni entradas, ' +
      'ni mermas. Si hace falta, se puede reabrir, y queda anotado.';
  $('ci-solo-al-cerrar').style.display = soloGente ? 'none' : '';
  $('ci-solo-al-cerrar-2').style.display = soloGente ? 'none' : '';
  $('ci-btn-cerrar').style.display = soloGente ? 'none' : '';
  CONTEO = [];
  $('ci-efectivo').value = DIA ? Math.round(DIA.ventas.por_moneda.CUP || 0) : '';
  $('ci-transfer').value = DIA ? (DIA.ventas.por_moneda.USD || '') : '';
  $('ci-obs').value = '';
  $('ci-busq').value = '';
  $('ci-resultados').innerHTML = '';
  $('ci-ajustar').checked = false;
  try {
    const t = await api('/api/dia/teorico?sitio_id=' + encodeURIComponent(sitioActual()) + '&fecha=' + fechaDia());
    TEORICO = t.teorico || {};
  } catch (e) { TEORICO = {}; }
  // Los que ya estén marcados de antes se respetan: se puede abrir el cierre,
  // marcar a la gente, cerrarlo sin cerrar el día y volver más tarde.
  GENTE_DIA = new Set((DIA && DIA.trabajaron) || []);
  renderGenteDia();
  renderConteo();
  compararCaja();
  $('velo-cierre').classList.add('abierto');
}
function cerrarCierre() { $('velo-cierre').classList.remove('abierto'); }

// ─── Quiénes trabajaron ese día ───────────────────────────────
// El reparto de la comisión sale de aquí (DECISIONES.md #32). Los nombres los
// manda /api/dia y no /api/personas: esa pide permiso para gestionar personal, y
// quien cierra el día muchas veces no lo tiene.
let GENTE_DIA = new Set();

function marcarGenteDia(id, si) {
  if (si) GENTE_DIA.add(id); else GENTE_DIA.delete(id);
  renderGenteDia();
}

// Guardar solo la lista, sin cerrar el día.
async function guardarGenteDia() {
  try {
    await api('/api/dias/personas', { method: 'POST', body: JSON.stringify({
      sitio_id: sitioActual(), fecha: fechaDia(), personas: [...GENTE_DIA] }) });
    cerrarCierre();
    toast(GENTE_DIA.size ? '✓ Apuntados ' + GENTE_DIA.size + ' trabajador(es)'
                         : '✓ Guardado: nadie apuntado ese día');
    await cargarDia();
  } catch (e) { alert('No se pudo guardar: ' + e.message); }
}

function renderGenteDia() {
  const gente = (DIA && DIA.gente) || [];
  if (!gente.length) {
    $('ci-gente').innerHTML = '<div class="vacio">No hay trabajadores creados.</div>';
    $('ci-gente-nota').textContent = '';
    return;
  }
  $('ci-gente').innerHTML = gente.map(p => `
    <label class="casilla" style="display:flex;align-items:center;gap:9px;padding:7px 0;cursor:pointer">
      <input type="checkbox" style="width:auto;margin:0" ${GENTE_DIA.has(p.id) ? 'checked' : ''}
             onchange="marcarGenteDia('${p.id}',this.checked)">
      <span>${esc(p.nombre)}</span>
    </label>`).join('');
  // Se dice a cuánto le toca a cada uno con los que hay marcados AHORA, que es
  // la pregunta que se hace quien está mirando la pantalla.
  const n = GENTE_DIA.size;
  const com = DIA && DIA.ventas ? Number(DIA.ventas.comision || 0) : 0;
  $('ci-gente-nota').innerHTML = !n
    ? 'Sin nadie marcado: la comisión de hoy se queda de quien hizo cada venta.'
    : 'La comisión de hoy (' + enBase(com) + ') se divide entre ' + n +
      ': <b>' + enBase(com / n) + '</b> para cada uno.';
}

// Lo cobrado según las ventas contra lo que hay de verdad en la caja.
function compararCaja() {
  if (!DIA) return;
  // Cada moneda se cuadra por su lado: una diferencia en dólares no se tapa
  // con un sobrante en pesos.
  const esp = { CUP: DIA.ventas.por_moneda.CUP || 0, USD: DIA.ventas.por_moneda.USD || 0 };
  const hay = { CUP: parseFloat($('ci-efectivo').value) || 0,
                USD: parseFloat($('ci-transfer').value) || 0 };
  const partes = ['CUP', 'USD'].map(m => {
    const d = hay[m] - esp[m];
    if (Math.abs(d) < 0.005) return esp[m] || hay[m]
      ? `<div class="pista" style="color:var(--marca-claro)">✓ ${m}: cuadra (${dinero(esp[m], m)}).</div>` : '';
    return `<div class="aviso">En ${m} las ventas suman <b>${dinero(esp[m], m)}</b> y declaras
      <b>${dinero(hay[m], m)}</b>: ${d > 0 ? 'sobran' : 'faltan'} <b>${dinero(Math.abs(d), m)}</b>.</div>`;
  });
  $('ci-cuadre-caja').innerHTML = partes.join('');
}

function alConteo(id) {
  const p = PRODUCTOS.find(x => x.id === id);
  if (!p || CONTEO.find(c => c.producto_id === id)) { $('ci-busq').value = ''; $('ci-resultados').innerHTML = ''; return; }
  CONTEO.push({ producto_id: id, nombre: p.nombre, codigo: p.codigo,
                contado: Number(TEORICO[id] || 0) });
  $('ci-busq').value = '';
  $('ci-resultados').innerHTML = '';
  renderConteo();
}

function ponerContado(id, v) {
  const c = CONTEO.find(x => x.producto_id === id);
  if (!c) return;
  const n = parseFloat(v);
  // Contar no puede dar menos que nada (#40). Se corrige en el sitio en vez de
  // dejarlo pasar hasta el cartel: un conteo es lo que se ve en el estante.
  if (n < 0) { toast('⚠ Lo que no está se cuenta como cero'); c.contado = 0; }
  else c.contado = n;
  renderConteo();
}

function renderConteo() {
  $('ci-ajustar-caja').style.display = CONTEO.length ? 'block' : 'none';
  $('ci-conteo').innerHTML = CONTEO.map(c => {
    const t = Number(TEORICO[c.producto_id] || 0);
    const d = (isNaN(c.contado) ? t : c.contado) - t;
    return `<div class="linea">
      <div class="nm">${esc(c.nombre)}<small>debía haber ${t}${
        d ? ' · <b style="color:var(--rojo)">' + (d > 0 ? '+' : '') + d + '</b>' : ' · cuadra'}</small></div>
      <div class="cant"><input type="number" inputmode="decimal" value="${isNaN(c.contado) ? '' : c.contado}"
        onchange="ponerContado('${c.producto_id}',this.value)" style="width:74px"></div>
      <button class="quitar" onclick="CONTEO=CONTEO.filter(x=>x.producto_id!=='${c.producto_id}');renderConteo()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
  }).join('');
}

async function confirmarCierre() {
  const conDif = CONTEO.filter(c => !isNaN(c.contado) && c.contado !== Number(TEORICO[c.producto_id] || 0));
  if (conDif.length && !$('ci-ajustar').checked) {
    if (!confirm('Hay ' + conDif.length + ' producto(s) con diferencia y no marcaste ajustar.\n\n' +
                 'El descuadre queda registrado, pero el inventario seguirá como está.\n\n¿Cerrar así?')) return;
  }
  try {
    const r = await api('/api/dias/cerrar', { method: 'POST', body: JSON.stringify({
      sitio_id: sitioActual(),
      fecha: fechaDia(),
      efectivo: parseFloat($('ci-efectivo').value) || 0,
      efectivo_usd: parseFloat($('ci-transfer').value) || 0,
      obs: $('ci-obs').value.trim() || null,
      ajustar: $('ci-ajustar').checked,
      // Quiénes trabajaron viaja con el cierre, no en otra llamada: si se
      // perdiera la segunda —el internet de un teléfono—, el día quedaría cerrado
      // y la lista a medias, y el reparto de la comisión saldría mal sin que
      // nadie lo notara.
      personas: [...GENTE_DIA],
      conteos: CONTEO.filter(c => !isNaN(c.contado))
        .map(c => ({ producto_id: c.producto_id, contado: c.contado }))
    })});
    cerrarCierre();
    toast(r.diferencias ? '✓ Día cerrado con ' + r.diferencias + ' descuadre(s)' : '✓ Día cerrado');
    await cargarDia();
    await cargarStock();
  } catch (e) { alert('No se pudo cerrar: ' + e.message); }
}

// ─── Ventas del día ───────────────────────────────────────────
async function cargarVentas() {
  const hoy = fechaDia();
  try {
    const d = await api('/api/ventas?sitio_id=' + encodeURIComponent(sitioActual()) + '&fecha=' + hoy);
    // Los totales los pinta cargarDia() con las cifras del servidor; aquí solo
    // va el listado, para que no haya dos sitios calculando lo mismo.
    const cerrado = DIA && DIA.cerrado;
    $('lista-ventas').innerHTML = d.ventas.length ? d.ventas.map(v => `
      <div class="venta ${v.anulada_en ? 'anulada' : ''}">
        <div class="cab">
          <span class="hora">${new Date(v.ts).toLocaleTimeString('es-CU', { hour: '2-digit', minute: '2-digit' })}
            · ${esc(v.moneda || 'CUP')}${v.cliente ? ' · ' + esc(v.cliente) : ''}</span>
          <span class="imp">${dinero(v.total, v.moneda)}</span>
        </div>
        ${!v.anulada_en && v.falta > 0.005 ? `<div class="det" style="color:var(--rojo)">
          Debe ${dinero(v.falta, v.moneda)}${v.cobrado > 0.005
            ? ' · pagó ' + dinero(v.cobrado, v.moneda) : ''}</div>` : ''}
        <div class="det">${v.lineas.map(l =>
            esc(l.nombre) + ' ×' + Math.abs(l.cantidad)).join(' · ') || '—'}</div>
        ${v.anulada_en ? '<div class="det" style="color:var(--rojo)">Anulada</div>'
          : (cerrado ? '' : `<button class="acc" onclick="anularVenta('${v.id}')">Anular esta venta</button>`)}
      </div>`).join('') : '<div class="vacio">Todavía no hay ventas hoy.</div>';
  } catch (e) {
    $('lista-ventas').innerHTML = '<div class="vacio">' + e.message + '</div>';
  }
}

async function anularVenta(id) {
  if (!confirm('¿Anular esta venta?\n\nLa mercancía vuelve al inventario. La venta no se ' +
               'borra: queda marcada como anulada para que el historial cuente lo que pasó.')) return;
  try {
    await api('/api/ventas/' + id + '/anular', { method: 'POST' });
    toast('✓ Venta anulada');
    await cargarStock();
    await cargarVentas();
  } catch (e) { alert('No se pudo anular: ' + e.message); }
}

// ═══════════════════════════════════════════════════════════════
//  ALMACÉN: existencias, entradas, mermas y traslados
// ═══════════════════════════════════════════════════════════════

let TRASLADOS = [];
let movTipo = 'compra';
let movProducto = null;
let DESPACHO = [];   // [{producto_id, nombre, codigo, cantidad}]
let recibiendo = null;

// Lo que hay en todo el negocio, y repartido por sitios. Se pide aparte del
// stock del sitio: son dos preguntas distintas y las dos hacen falta.
let STOCK_TOTAL = {}, STOCK_REPARTO = {};

async function cargarStockTotal() {
  try {
    const d = await api('/api/stock/total');
    STOCK_TOTAL = d.stock || {};
    STOCK_REPARTO = d.por_sitio || {};
  } catch (e) { STOCK_TOTAL = {}; STOCK_REPARTO = {}; }
}

function cambiarAlcanceAlmacen() {
  const todos = $('alm-alcance').value === 'todos';
  // En la vista de todo el negocio no se puede mover mercancía: una entrada o
  // una merma tienen que ir a un sitio concreto, no «a todos».
  $('alm-acciones').style.display = todos ? 'none' : 'flex';
  $('transitos').style.display = todos ? 'none' : 'block';
  renderAlmacen();
}

let almacenPintadoDe = null;      // de qué sitio se pintó la última vez

async function cargarAlmacen() {
  pintarSelectorSitio();

  // CON UN SOLO SITIO, la vista de «todo el negocio» no suma nada: enseña
  // exactamente lo mismo que «solo lo que hay aquí». Y a cambio esconde los
  // botones de Entrada, Merma y Transferencia, porque una entrada tiene que ir a un
  // sitio concreto y no «a todos».
  //
  // El resultado era una pantalla de Almacén SIN NINGUNA FORMA DE METER
  // MERCANCÍA, y así se encontró el dueño la aplicación el 1-sep-2026: entraba,
  // veía «Todo el negocio, sumado», ni un botón, y una lista vacía. No estaba
  // rompiendo nada ninguna regla; era una vista pensada para varios almacenes
  // puesta delante de un negocio que de momento tiene uno.
  //
  // Así que con un solo sitio el desplegable no se enseña, y vuelve solo el día
  // que se cree un punto de venta. Nada que configurar.
  const variosSitios = SITIOS.filter(s => s.activo !== 0).length > 1;
  $('alm-alcance-caja').style.display = variosSitios ? '' : 'none';
  // Transferir es mandar mercancía a OTRO sitio: sin otro sitio no hay destino.
  // Se mira también el permiso, porque este renglón pisa lo que dejó puesto
  // aplicarPermisos() al entrar.
  $('btn-despachar').style.display =
    (variosSitios && puedo('traslados_enviar')) ? '' : 'none';

  // El Almacén abre SIEMPRE en «solo lo que hay aquí», también en el almacén
  // principal. Lo pidió el dueño el 1-sep-2026: lo primero que quiere ver al
  // entrar es su estante, no una suma. La vista de todo el negocio sigue
  // estando, a un toque del desplegable, cuando haya más de un sitio.
  //
  // Antes abría en «todo el negocio» estando en el principal, por la decisión
  // #22 —el almacén principal es el mirador—. Eso se queda para Cierre y Dinero,
  // que es donde de verdad se llevan las cuentas de todo; en el Almacén, la
  // pantalla de la que se sale a mover mercancía, mandaba el estante.
  //
  // Solo se toca al CAMBIAR de sitio: si se hiciera en cada recarga, desharía lo
  // que la persona acabe de elegir en el desplegable.
  if (almacenPintadoDe !== sitioActual()) {
    almacenPintadoDe = sitioActual();
    $('alm-alcance').value = 'sitio';
  }
  // Y si el desplegable no está a la vista, su valor no puede quedarse en
  // «todos» de una temporada en que sí había dos sitios: lo escondido no se
  // puede corregir a mano.
  if (!variosSitios) $('alm-alcance').value = 'sitio';
  await cargarStock();
  await cargarStockTotal();
  try {
    const d = await api('/api/traslados?sitio_id=' + encodeURIComponent(sitioActual()));
    TRASLADOS = d.traslados || [];
  } catch (e) { TRASLADOS = []; }
  rellenarCategoriasAlmacen();
  renderTransitos();
  cambiarAlcanceAlmacen();
}

function rellenarCategoriasAlmacen() {
  // Como en Productos, las categorías son las de lo que se está mirando (#45).
  const cats = [...new Set(productosDelAlmacen().map(p => p.categoria).filter(Boolean))].sort();
  const sel = $('alm-cat'), antes = sel.value;
  sel.innerHTML = '<option value="">Todas las categorías</option>' +
    cats.map(c => `<option>${esc(c)}</option>`).join('');
  sel.value = antes;
}

function renderAlmacen() {
  const q = ($('alm-busq').value || '').trim().toLowerCase();
  const cat = $('alm-cat').value;
  const filtro = $('alm-filtro').value;
  const todos = $('alm-alcance').value === 'todos';

  let lista = productosDelAlmacen();
  if (cat) lista = lista.filter(p => p.categoria === cat);
  if (q) lista = lista.filter(p =>
    (p.nombre || '').toLowerCase().includes(q) ||
    (p.codigo || '').toLowerCase().includes(q) ||
    (p.codigo_barra || '').toLowerCase().includes(q));
  // Cuántos quedan ANTES de filtrar por existencia. Es lo que permite distinguir
  // «no hay productos» de «los hay, pero ninguno tiene mercancía todavía».
  const antesDeExistencia = lista.length;

  const hay = p => Number((todos ? STOCK_TOTAL : STOCK)[p.id] || 0);
  if (filtro === 'con') lista = lista.filter(p => hay(p) > 0);
  else if (filtro === 'bajo') lista = lista.filter(p => hay(p) <= (p.stock_min || 0));
  else if (filtro === 'negativo') lista = lista.filter(p => hay(p) < 0);

  lista.sort((a, b) => a.nombre.localeCompare(b.nombre));

  let valor = 0;
  PRODUCTOS.forEach(p => { const n = hay(p); if (n > 0) valor += n * (p.costo || 0); });

  $('alm-cuenta').textContent = lista.length + (lista.length === 1 ? ' producto' : ' productos') +
    (todos ? ' en todo el negocio' : '');
  $('alm-valor').textContent = conRef(valor);
  $('alm-valor-nota').textContent = todos
    ? 'Al costo que pagaste, sumando lo que hay en todos los almacenes y puntos.'
    : 'Al costo que pagaste, contando solo lo que tiene existencia en este sitio.';

  $('alm-lista').innerHTML = lista.length ? lista.map(p => {
    const n = hay(p);
    // En la vista de todo el negocio se enseña dónde está repartido: el total
    // sin el reparto no sirve para decidir de dónde sacarlo.
    const reparto = todos ? (STOCK_REPARTO[p.id] || [])
      .filter(r => r.cantidad !== 0)
      .map(r => esc(r.sitio) + ' ' + r.cantidad).join(' · ') : '';
    return `<div class="prod" onclick="abrirFicha('${p.id}')">
      <span class="cod">${esc(p.codigo)}</span>
      <div class="info"><div class="nm">${esc(p.nombre)}</div>
        <div class="sub">${todos ? (reparto || 'Sin existencia en ningún sitio')
          : esc(p.categoria || 'Sin categoría') + ' · costo ' + enBase(p.costo)}${
          // Lo mismo contado en bultos (#44). Es la cifra con la que se cuenta el
          // estante en el almacén principal: «240» no se cuenta, «10 cajas» sí.
          enBultos(p, n) ? ' · ' + esc(enBultos(p, n)) : ''}</div></div>
      <div class="pre">${todos
        ? '<b>' + n + '</b><span>' + enBase(n > 0 ? n * (p.costo || 0) : 0) + '</span>'
        : pillStock(p.id) + '<span>' + enBase(n > 0 ? n * (p.costo || 0) : 0) + '</span>'}</div>
      <span class="accIco editar" title="Tocar para editar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z"/></svg></span>
    </div>`;
  }).join('') : almacenVacio(filtro, antesDeExistencia, !!(q || cat));
}

// Por qué está vacía la lista. «Nada que mostrar con este filtro» no ayuda: no
// dice si es que no hay productos o que el filtro los tapa, y el almacén abre
// filtrando por «Con existencia». Un catálogo recién creado, sin entradas
// todavía, sale entero vacío y parece que la aplicación no ha guardado nada.
// Le pasó al dueño el 1-sep-2026, el mismo día y en la misma pantalla que lo de
// los botones escondidos.
function almacenVacio(filtro, antesDeExistencia, buscando) {
  if (!antesDeExistencia) return '<div class="vacio">' + (buscando
    ? 'Nada coincide con lo que buscas.'
    : 'Todavía no hay ningún producto en el catálogo.<br>' +
      'Créalo en la pantalla de <b>Productos</b>, aquí abajo.') + '</div>';
  if (filtro === 'con') return '<div class="vacio">Ninguno tiene existencia todavía.<br>' +
    'Tienes ' + antesDeExistencia + (antesDeExistencia === 1 ? ' producto' : ' productos') +
    ' en el catálogo · <button class="acc" onclick="verTodoElCatalogo()">Verlos todos</button>' +
    (puedo('gestionar_inventario')
      ? '<br>Para meter mercancía, el botón «Entrada» de arriba.' : '') + '</div>';
  return '<div class="vacio">Nada que mostrar con este filtro.</div>';
}
function verTodoElCatalogo() { $('alm-filtro').value = 'todos'; renderAlmacen(); }

// ─── Traslados en tránsito ────────────────────────────────────
function renderTransitos() {
  const yo = sitioActual();
  const porRecibir = TRASLADOS.filter(t => t.destino_id === yo && t.estado === 'en_transito');
  const enviados = TRASLADOS.filter(t => t.origen_id === yo && t.estado === 'en_transito');
  const resumen = t => t.enviado.map(l => esc(l.nombre) + ' ×' + l.cantidad).join(' · ');

  let html = '';
  if (porRecibir.length) html += `<div class="tarjeta" style="border-color:var(--acento)">
    <h2 style="color:var(--acento-osc)">Te están enviando</h2>
    ${porRecibir.map(t => `<div class="venta">
      <div class="cab"><span class="hora">Desde ${esc(t.origen)}</span>
        <span class="imp" style="font-size:12px">${new Date(t.despachado_en).toLocaleDateString('es-CU')}</span></div>
      <div class="det">${resumen(t)}</div>
      <button class="btn acento" style="margin-top:8px;padding:8px 14px;font-size:13px"
              onclick="abrirRecibir('${t.id}')">Confirmar lo que recibí</button>
    </div>`).join('')}</div>`;

  if (enviados.length) html += `<div class="tarjeta">
    <h2>Enviado, esperando confirmación</h2>
    ${enviados.map(t => `<div class="venta">
      <div class="cab"><span class="hora">Hacia ${esc(t.destino)}</span>
        <span class="imp" style="font-size:12px">${new Date(t.despachado_en).toLocaleDateString('es-CU')}</span></div>
      <div class="det">${resumen(t)}</div>
      <button class="acc" onclick="cancelarTraslado('${t.id}')">Cancelar y devolver al inventario</button>
    </div>`).join('')}</div>`;

  // Recibidos a medias: la diferencia queda a la vista, no se corrige sola
  const parciales = TRASLADOS.filter(t => t.estado === 'recibido_parcial').slice(0, 5);
  if (parciales.length) html += `<div class="tarjeta" style="border-color:rgba(192,57,43,.4)">
    <h2 style="color:var(--rojo)">Llegó menos de lo que salió</h2>
    ${parciales.map(t => {
      const env = {}; t.enviado.forEach(l => { env[l.producto_id] = l; });
      const rec = {}; t.recibido.forEach(l => { rec[l.producto_id] = (rec[l.producto_id] || 0) + l.cantidad; });
      const faltas = Object.values(env).map(l => {
        const r = rec[l.producto_id] || 0;
        return r < l.cantidad ? esc(l.nombre) + ': salieron ' + l.cantidad + ', llegaron ' + r : null;
      }).filter(Boolean);
      return `<div class="venta"><div class="cab"><span class="hora">${esc(t.origen)} → ${esc(t.destino)}</span></div>
        <div class="det">${faltas.join('<br>')}</div></div>`;
    }).join('')}</div>`;

  $('transitos').innerHTML = html;
}

async function cancelarTraslado(id) {
  if (!confirm('¿Cancelar este traslado?\n\nLa mercancía vuelve al inventario de aquí. ' +
               'Solo se puede mientras el destino no haya confirmado.')) return;
  try {
    await api('/api/traslados/' + id + '/cancelar', { method: 'POST' });
    toast('✓ Traslado cancelado');
    await cargarAlmacen();
  } catch (e) { alert('No se pudo cancelar: ' + e.message); }
}

// ─── Entrada / merma ──────────────────────────────────────────
function abrirMov(tipo) {
  movTipo = tipo;
  movProducto = null;
  const esCompra = tipo === 'compra';
  $('mov-titulo').textContent = esCompra ? 'Entrada de mercancía' : 'Registrar merma';
  $('mov-pista').textContent = esCompra
    ? 'Mercancía que entra a ' + (SITIOS.find(s => s.id === sitioActual()) || {}).nombre + '.'
    : 'Mercancía que se pierde: rota, vencida o robada. Sale del inventario y cuenta como pérdida.';
  $('mov-costo-caja').style.display = esCompra ? 'block' : 'none';
  $('mov-actualizar-caja').style.display = 'none';
  $('mov-motivo-caja').style.display = esCompra ? 'none' : 'block';
  $('mov-busq').value = ''; $('mov-cant').value = ''; $('mov-costo').value = '';
  $('mov-obs').value = '';
  $('mov-resultados').innerHTML = '';
  $('mov-elegido').style.display = 'none';
  $('mov-hay').innerHTML = '';
  $('velo-mov').classList.add('abierto');
  setTimeout(() => $('mov-busq').focus(), 120);
}
function cerrarMov() { $('velo-mov').classList.remove('abierto'); }

// El buscador que sale dentro de las ventanas. Con 'dejaCrear' añade al final
// la opción de crear el producto que se está escribiendo: al apuntar una
// compra, la mitad de lo que llega es mercancía que todavía no está en el
// catálogo, y obligar a salir a Productos y volver a empezar es la forma más
// segura de que la compra se apunte a medias o no se apunte.
function buscarEnModal(inputId, contId, alElegir, dejaCrear) {
  const q = ($(inputId).value || '').trim().toLowerCase();
  const cont = $(contId);
  if (!q) { cont.innerHTML = ''; return; }
  const lista = productosAqui().filter(p => (
    (p.nombre || '').toLowerCase().includes(q) ||
    (p.codigo || '').toLowerCase().includes(q) ||
    (p.codigo_barra || '').toLowerCase().includes(q))).slice(0, 6);
  const exacto = lista.some(p => (p.nombre || '').toLowerCase() === q);
  const crear = (dejaCrear && !exacto && puedo('gestionar_productos'))
    ? `<div class="prod" onclick="crearProductoDesde('${inputId}','${alElegir}')">
        <span class="cod">nuevo</span>
        <div class="info"><div class="nm">Crear «${esc($(inputId).value.trim())}»</div>
          <div class="sub">Se añade al catálogo con ese nombre. El precio de venta y la
            foto se le ponen luego, en Productos.</div></div></div>` : '';
  cont.innerHTML = (lista.map(p => `<div class="prod" onclick="${alElegir}('${p.id}')">
      <span class="cod">${esc(p.codigo)}</span>
      <div class="info"><div class="nm">${esc(p.nombre)}</div>
        <div class="sub">${pillStock(p.id)}</div></div></div>`).join('') ||
    (crear ? '' : '<div class="vacio" style="padding:14px">Sin coincidencias</div>')) + crear;
}

// Crea el producto con lo que se haya escrito y lo mete de una vez en la lista
// que se estaba armando. El código correlativo lo pone el servidor.
//
// Se pregunta la UNIDAD antes de crearlo. Creándolo solo con el nombre se
// quedaba en «Unidad» y un cable que se vende por metros aparecía contado por
// unidades: el inventario decía una cosa y el almacén otra, y arreglarlo
// después no recalcula lo que ya se apuntó.
let PROD_RAPIDO = null;
function crearProductoDesde(inputId, alElegir) {
  const nombre = ($(inputId).value || '').trim();
  if (nombre.length < 2) { toast('⚠ Escribe el nombre del producto'); return; }
  PROD_RAPIDO = { alElegir };
  $('np-nombre').value = nombre;
  $('np-um').value = 'Unidad';
  $('velo-nuevoprod').classList.add('abierto');
  setTimeout(() => $('np-um').focus(), 80);
}
function cerrarProductoRapido() {
  $('velo-nuevoprod').classList.remove('abierto');
  PROD_RAPIDO = null;
}
async function confirmarProductoRapido() {
  if (!PROD_RAPIDO) return;
  const nombre = ($('np-nombre').value || '').trim();
  if (nombre.length < 2) { toast('⚠ Escribe el nombre del producto'); return; }
  const alElegir = PROD_RAPIDO.alElegir;
  try {
    // Nace en el local donde se está trabajando (#45): se está creando en mitad de
    // una entrada, una merma o un despacho de ESTE sitio. Dejarlo sin local lo
    // escondería de la propia pantalla desde la que se acaba de crear.
    const r = await api('/api/productos', { method: 'POST', body: JSON.stringify({
      nombre, um: ($('np-um').value || '').trim() || 'Unidad',
      sitio_id: sitioActual() }) });
    cerrarProductoRapido();
    await cargarCatalogo();
    toast('✓ ' + r.codigo + ' creado');
    window[alElegir](r.id);
  } catch (e) { alert('No se pudo crear: ' + e.message); }
}

function elegirMovProducto(id) {
  movProducto = PRODUCTOS.find(p => p.id === id);
  if (!movProducto) return;
  $('mov-busq').value = '';
  $('mov-resultados').innerHTML = '';
  $('mov-elegido').style.display = 'block';
  $('mov-elegido-nm').textContent = movProducto.codigo + ' · ' + movProducto.nombre;
  if (movTipo === 'compra') {
    $('mov-costo').value = movProducto.costo || '';
    // Con la moneda escrita al lado no hay que acordarse de en qué se mide el
    // negocio: teclear dólares donde se esperan pesos deja el costo cien veces
    // por debajo y no se nota hasta que la ganancia del mes sale absurda.
    $('mov-costo-lbl').textContent = 'Costo por unidad (' + MONEDA_BASE + ')';
    $('mov-actualizar-caja').style.display = 'block';
  }
  // El desplegable de la medida solo sale si ese producto viene en bultos (#44):
  // para los demás, ofrecer «cajas» sería ofrecer una forma de equivocarse.
  const sel = $('mov-medida');
  if (sel) {
    const tiene = Number(movProducto.unidades_por_caja) > 0;
    sel.style.display = tiene ? '' : 'none';
    sel.innerHTML = !tiene ? '' :
      '<option value="unidad">' + esc(enPlural(movProducto.um || 'Unidad')) + '</option>' +
      '<option value="caja">' + esc(rotuloBulto(movProducto)) + '</option>';
    sel.value = 'unidad';
  }
  alPonerCantMov();
  setTimeout(() => $('mov-cant').focus(), 60);
}

// En qué está escrita la cantidad de la entrada: en unidades o en bultos.
const medidaMov = () => ($('mov-medida') && $('mov-medida').style.display !== 'none'
  ? $('mov-medida').value : 'unidad');
// Y cuántas unidades son. La cuenta la vuelve a hacer el servidor, que es quien
// manda (#10): esto solo sirve para poder enseñarlo antes de guardar.
const unidadesMov = cant => medidaMov() === 'caja'
  ? cant * (Number(movProducto && movProducto.unidades_por_caja) || 0) : cant;

// Lo que hay de ese producto en ESTE sitio, y en rojo si la merma se pasa. Es la
// misma idea que el saldo debajo del desplegable de la caja (#38): la cifra
// delante evita el cartel, y el cartel del servidor sigue estando por si acaso.
function hayAquiMov(id) { return Number(STOCK[id] || 0); }
function alPonerCantMov() {
  const caja = $('mov-hay');
  if (!caja) return;
  if (!movProducto) { caja.innerHTML = ''; return; }
  const um = movProducto.um && movProducto.um !== 'Unidad' ? ' ' + movProducto.um : '';
  // Escribiendo en bultos, lo que se va a guardar se dice ANTES de guardarlo:
  // «3 cajas = 72 unidades». Sin eso hay que fiarse de una multiplicación hecha
  // de cabeza, que es justo lo que esto viene a quitar.
  const escrito = parseFloat($('mov-cant').value);
  if (medidaMov() === 'caja' && !isNaN(escrito) && escrito > 0) {
    const uds = unidadesMov(escrito);
    caja.innerHTML = '<b>' + esc(bultosEscritos(movProducto, escrito)) + ' = ' + uds +
      ' ' + esc(enPlural(movProducto.um || 'unidad')) + '</b>' +
      (movTipo === 'merma' ? ' · en este sitio hay ' + hayAquiMov(movProducto.id) + esc(um) : '');
    return;
  }
  if (movTipo !== 'merma') { caja.innerHTML = ''; return; }
  const hay = hayAquiMov(movProducto.id);
  const cant = escrito;
  const pasa = !isNaN(cant) && cant > hay + 0.0001;
  caja.innerHTML = pasa
    ? '<b style="color:var(--rojo)">Solo hay ' + hay + um + ' en este sitio</b>, y estás dando ' +
      'de baja ' + cant + '. No se puede rebajar mercancía que no está.'
    : 'En este sitio hay <b>' + hay + um + '</b>. No se puede dar de baja más de lo que hay.';
}

async function guardarMov() {
  if (!movProducto) { toast('⚠ Elige un producto'); return; }
  const cant = parseFloat($('mov-cant').value);
  if (!cant || cant <= 0) { toast('⚠ Pon la cantidad'); $('mov-cant').focus(); return; }
  // La medida viaja con la cantidad y la convierte el SERVIDOR (#44). Aquí no se
  // multiplica nada: si se multiplicara aquí y el servidor también, entrarían 576
  // unidades donde iban 24.
  const medida = medidaMov();
  // La pantalla para lo evidente; el servidor manda igual (#10). Aquí se usa lo
  // que se trajo al abrir, que puede haber envejecido: si desde otro dispositivo
  // se vendió mientras tanto, quien dice que no es el servidor.
  if (movTipo === 'merma' && unidadesMov(cant) > hayAquiMov(movProducto.id) + 0.0001) {
    alPonerCantMov();
    toast('⚠ No hay tanto para dar de baja');
    $('mov-cant').focus();
    return;
  }
  const cuerpo = {
    tipo: movTipo,
    sitio_id: sitioActual(),
    producto_id: movProducto.id,
    cantidad: cant,
    medida,
    obs: $('mov-obs').value.trim() || null,
    fecha: new Date().toLocaleDateString('sv-SE')
  };
  if (movTipo === 'compra') {
    cuerpo.costo_unit = parseFloat($('mov-costo').value) || movProducto.costo;
    cuerpo.actualizar_costo = $('mov-actualizar').checked;
  } else {
    cuerpo.motivo = $('mov-motivo').value;
  }
  try {
    await api('/api/movimientos', { method: 'POST', body: JSON.stringify(cuerpo) });
    cerrarMov();
    toast(movTipo === 'compra' ? '✓ Entrada registrada' : '✓ Merma registrada');
    await cargarCatalogo();
    await cargarAlmacen();
  } catch (e) { alert('No se pudo registrar: ' + e.message); }
}

// ─── Transferencia ────────────────────────────────────────────────
function abrirDespacho() {
  DESPACHO = [];
  const otros = SITIOS.filter(s => s.id !== sitioActual());
  if (!otros.length) { alert('Todavía no hay otro sitio al que transferir.\n\nCrea un punto de venta en Ajustes.'); return; }
  $('des-destino').innerHTML = otros.map(s => `<option value="${s.id}">${esc(s.nombre)}</option>`).join('');
  $('des-busq').value = ''; $('des-obs').value = '';
  $('des-resultados').innerHTML = '';
  renderDespacho();
  $('velo-despacho').classList.add('abierto');
  setTimeout(() => $('des-busq').focus(), 120);
}
function cerrarDespacho() { $('velo-despacho').classList.remove('abierto'); }

function alDespacho(id) {
  const p = PRODUCTOS.find(x => x.id === id);
  if (!p) return;
  const l = DESPACHO.find(x => x.producto_id === id);
  if (l) l.cantidad++;
  else DESPACHO.push({ producto_id: id, nombre: p.nombre, codigo: p.codigo, cantidad: 1 });
  $('des-busq').value = '';
  $('des-resultados').innerHTML = '';
  renderDespacho();
  $('des-busq').focus();
}

// Las unidades que salen de una línea del despacho. AQUÍ ES DONDE HACE FALTA EL
// CAMBIO DE MEDIDA (#44): el almacén cuenta por cajas y la tienda por unidades, y
// escribir «3» queriendo decir tres cajas tiene que sacar 72 del estante.
//
// Esto es para ENSEÑARLO; la cuenta que vale la vuelve a hacer el servidor.
function udsDespacho(l) {
  const p = PRODUCTOS.find(x => x.id === l.producto_id);
  const por = Number(p && p.unidades_por_caja) || 0;
  return l.medida === 'caja' && por > 0 ? l.cantidad * por : l.cantidad;
}

function renderDespacho() {
  $('des-carro').innerHTML = DESPACHO.length ? DESPACHO.map(l => {
    const p = PRODUCTOS.find(x => x.id === l.producto_id) || {};
    const hay = Number(STOCK[l.producto_id] || 0);
    const uds = udsDespacho(l);
    // Lo que no está no se despacha (#40): se ve en la línea antes de mandar el
    // envío, igual que en los materiales de un trabajo.
    const falta = uds > hay + 0.0001;
    const enBulto = Number(p.unidades_por_caja) > 0;
    return `<div class="linea">
      <div class="nm">${esc(l.nombre)}<small>${esc(l.codigo)} · ${falta
        ? '<b style="color:var(--rojo)">solo hay ' + hay + '</b>' : 'hay ' + hay}${
        enBultos(p, hay) ? ' (' + esc(enBultos(p, hay)) + ')' : ''}</small>
        ${enBulto ? `<select style="margin-top:4px;font-size:12px;padding:4px 6px"
            onchange="ponerMedidaDespacho('${l.producto_id}',this.value)">
          <option value="unidad"${l.medida !== 'caja' ? ' selected' : ''}>${
            esc(enPlural(p.um || 'Unidad'))}</option>
          <option value="caja"${l.medida === 'caja' ? ' selected' : ''}>${
            esc(rotuloBulto(p))}</option>
        </select>` : ''}
        ${l.medida === 'caja' ? '<small><b>= ' + uds + ' ' +
          esc(enPlural(p.um || 'unidad')) + '</b></small>' : ''}
      </div>
      <div class="cant">
        <button onclick="cantDespacho('${l.producto_id}',-1)">−</button>
        <input type="number" inputmode="decimal" value="${l.cantidad}" style="${
          falta ? 'border-color:var(--rojo)' : ''}"
               onchange="ponerCantDespacho('${l.producto_id}',this.value)">
        <button onclick="cantDespacho('${l.producto_id}',1)">+</button>
      </div>
    </div>`;
  }).join('') : '<div class="pista">Busca productos arriba para añadirlos al envío.</div>';
}
function ponerMedidaDespacho(id, medida) {
  const l = DESPACHO.find(x => x.producto_id === id);
  if (!l) return;
  l.medida = medida === 'caja' ? 'caja' : 'unidad';
  renderDespacho();
}
function cantDespacho(id, d) {
  const l = DESPACHO.find(x => x.producto_id === id);
  if (!l) return;
  l.cantidad = Math.max(0, l.cantidad + d);
  if (!l.cantidad) DESPACHO = DESPACHO.filter(x => x.producto_id !== id);
  renderDespacho();
}
function ponerCantDespacho(id, v) {
  const l = DESPACHO.find(x => x.producto_id === id);
  if (!l) return;
  const n = parseFloat(v);
  l.cantidad = isNaN(n) || n <= 0 ? 1 : n;
  renderDespacho();
}

async function guardarDespacho() {
  if (!DESPACHO.length) { toast('⚠ Añade algún producto'); return; }
  const pasadas = DESPACHO.filter(l => udsDespacho(l) > Number(STOCK[l.producto_id] || 0) + 0.0001);
  if (pasadas.length) {
    alert('No se puede transferir mercancía que no está:\n\n' +
      pasadas.map(l => '· ' + l.nombre + ': hay ' + Number(STOCK[l.producto_id] || 0) +
                       ' y estás enviando ' + udsDespacho(l)).join('\n') +
      '\n\nApunta primero la entrada de esa mercancía, o envía lo que haya de verdad.');
    return;
  }
  try {
    await api('/api/traslados', { method: 'POST', body: JSON.stringify({
      origen_id: sitioActual(),
      destino_id: $('des-destino').value,
      obs: $('des-obs').value.trim() || null,
      fecha: new Date().toLocaleDateString('sv-SE'),
      // La medida viaja y la convierte el SERVIDOR (#44 y #10). Si se convirtiera
      // aquí, un dispositivo con el código viejo mandaría cajas creyendo que manda
      // unidades y saldría del almacén una fracción de lo que se quería enviar.
      lineas: DESPACHO.map(l => ({ producto_id: l.producto_id, cantidad: l.cantidad,
                                   medida: l.medida || 'unidad' }))
    })});
    cerrarDespacho();
    toast('✓ Transferido. Esperando que confirmen allí.');
    await cargarAlmacen();
  } catch (e) { alert('No se pudo transferir: ' + e.message); }
}

// ─── Recibir ──────────────────────────────────────────────────
function abrirRecibir(id) {
  recibiendo = TRASLADOS.find(t => t.id === id);
  if (!recibiendo) return;
  $('rec-lineas').innerHTML = recibiendo.enviado.map(l => {
    const p = PRODUCTOS.find(x => x.id === l.producto_id) || {};
    const bultos = enBultos(p, l.cantidad);
    return `
    <div class="linea">
      <div class="nm">${esc(l.nombre)}<small>${esc(l.codigo)} · salieron ${l.cantidad}${
        bultos ? ' (' + esc(bultos) + ')' : ''}</small></div>
      <div class="cant">
        <input type="number" inputmode="decimal" data-prod="${l.producto_id}"
               value="${l.cantidad}" style="width:70px">
      </div>
    </div>`; }).join('');
  $('velo-recibir').classList.add('abierto');
}
function cerrarRecibir() { $('velo-recibir').classList.remove('abierto'); recibiendo = null; }

async function guardarRecepcion() {
  if (!recibiendo) return;
  const lineas = [...document.querySelectorAll('#rec-lineas input')].map(i => ({
    producto_id: i.dataset.prod, cantidad: parseFloat(i.value) || 0
  }));
  try {
    const r = await api('/api/traslados/' + recibiendo.id + '/recibir', {
      method: 'POST', body: JSON.stringify({ lineas }) });
    cerrarRecibir();
    toast(r.completo ? '✓ Recibido completo' : '✓ Recibido, con faltante anotado');
    // El catálogo TAMBIÉN, y no solo el almacén: lo que acaba de llegar puede ser
    // un producto que este local no tenía todavía, y hasta que no se vuelve a pedir
    // no sabe que ya es suyo (#45). Sin esto se recibiría mercancía que no se puede
    // vender hasta salir y volver a entrar en la aplicación.
    await cargarCatalogo();
    await cargarAlmacen();
  } catch (e) { alert('No se pudo confirmar: ' + e.message); }
}

// ═══════════════════════════════════════════════════════════════
//  DINERO: el fondo, las inversiones y las comisiones
// ═══════════════════════════════════════════════════════════════

let fondoTipo = 'retiro';
let fondoEditando = null;   // el id del apunte que se está corrigiendo, si lo hay
let APUNTE_ABIERTO = null;  // el apunte que se está mirando en la ficha
const SUBTIPOS = {
  retiro:    ['Salario de jefe', 'Reparto de ganancias', 'Préstamo', 'Otro'],
  inversion: ['Compra de productos', 'Equipos o herramientas',
              'Local o transporte', 'Otro'],
  gasto:     ['Electricidad', 'Transporte', 'Impuestos', 'Salarios', 'Alquiler', 'Otro'],
  ingreso:   ['Aporte de socio', 'Cobro pendiente', 'Otro']
};

function pestanaDinero(cual, btn) {
  document.querySelectorAll('.pestanas button').forEach(b => b.classList.remove('activa'));
  if (btn) btn.classList.add('activa');
  ['fondo', 'inversiones', 'comisiones', 'porcobrar'].forEach(x => {
    $('t-' + x).style.display = cual === x ? 'block' : 'none';
  });
  if (cual === 'inversiones') cargarInversiones();
  if (cual === 'comisiones') cargarComisiones();
  if (cual === 'porcobrar') cargarPorCobrar();
}

// ═══════════════════════════════════════════════════════════════
//  LO QUE ESTÁ POR COBRAR (DECISIONES.md #43)
// ═══════════════════════════════════════════════════════════════
// La pregunta que hay que poder contestar es «¿cuánto me debe fulano?», y por eso
// la lista va por CLIENTE y no por venta: quien viene a pagar es una persona, no
// un documento, y trae lo que trae para lo que deba.
let POR_COBRAR = null;

async function cargarPorCobrar() {
  try {
    POR_COBRAR = await api('/api/por-cobrar');
  } catch (e) {
    $('pc-lista').innerHTML = '<div class="vacio">' + esc(e.message) + '</div>';
    return;
  }
  await cargarClientes();
  const d = POR_COBRAR;
  $('pc-total').textContent = dinero(d.total.CUP || 0, 'CUP');
  $('pc-total-usd').textContent = dinero(d.total.USD || 0, 'USD');
  $('pc-total-usd').style.display = d.total.USD > 0.005 ? '' : 'none';

  const puedeCobrar = puedo('cobrar_ventas');
  $('pc-lista').innerHTML = (d.clientes || []).length ? d.clientes.map(c => `
    <div class="fila" style="align-items:flex-start;flex-wrap:wrap">
      <div style="flex:1;min-width:150px">
        <b>${esc(c.nombre)}</b>${c.telefono ? ' <span class="pista">' + esc(c.telefono) + '</span>' : ''}
        <div class="pista">${c.ventas.length} ${c.ventas.length === 1 ? 'venta' : 'ventas'} sin terminar de pagar</div>
      </div>
      <b class="num" style="color:var(--rojo)">${dinero(c.debe.CUP, 'CUP')}${
        c.debe.USD > 0.005 ? ' + ' + dinero(c.debe.USD, 'USD') : ''}</b>
      <div style="flex:1 1 100%;margin-top:6px">
        ${c.ventas.map(v => `<div class="fila" style="padding:6px 0">
          <span class="pista">${esc(v.fecha)}${v.cobrado > 0.005
            ? ' · ya pagó ' + dinero(v.cobrado, v.moneda) : ''}</span>
          <span>
            <b class="num">${dinero(v.falta, v.moneda)}</b>
            ${puedeCobrar ? `<button class="acc" style="margin-left:8px"
              onclick="abrirCobrarVenta('${v.id}')">Cobrar</button>` : ''}
          </span>
        </div>`).join('')}
      </div>
    </div>`).join('')
    : '<div class="vacio">Nadie debe nada. Todo lo que salió está cobrado.</div>';

  // Lo fiado sin cliente no debería existir —el servidor no deja fiar sin decir a
  // quién—, pero una base traída de otra copia podría traerlo. Si aparece se
  // dice: es dinero que no se le puede cobrar a nadie.
  if ((d.sin_cliente || []).length) {
    $('pc-lista').innerHTML += `<div class="aviso" style="margin-top:10px">
      <b>Hay ${d.sin_cliente.length} venta(s) sin pagar y sin cliente.</b> No se le pueden
      cobrar a nadie. Vinieron de otra copia de la aplicación.</div>`;
  }

  const puedeEditar = puedo('clientes');
  $('pc-clientes').innerHTML = CLIENTES.length ? CLIENTES.map(c => `
    <div class="fila">
      <span>${esc(c.nombre)}${c.telefono ? ' <span class="pista">' + esc(c.telefono) + '</span>' : ''}</span>
      ${puedeEditar ? `<button class="acc" onclick="abrirCliente('${c.id}')">Editar</button>` : ''}
    </div>`).join('') : '<div class="vacio">Todavía no hay ningún cliente.</div>';
}

// ─── La ficha de un cliente ───────────────────────────────────
let clienteEditando = null;

function abrirCliente(id) {
  const c = id ? CLIENTES.find(x => x.id === id) : null;
  clienteEditando = c ? c.id : null;
  $('cl-titulo').textContent = c ? 'Editar cliente' : 'Cliente nuevo';
  $('cl-nombre').value = c ? c.nombre : '';
  $('cl-telefono').value = c ? (c.telefono || '') : '';
  $('cl-direccion').value = c ? (c.direccion || '') : '';
  $('cl-nota').value = c ? (c.nota || '') : '';
  $('cl-baja').style.display = c ? 'inline-flex' : 'none';
  // Lo que debe, dicho en su propia ficha: es la primera pregunta que se hace
  // quien la abre, y si no está aquí hay que ir a buscarla a otra pantalla.
  const deuda = c && POR_COBRAR && (POR_COBRAR.clientes || []).find(x => x.id === c.id);
  $('cl-deuda').innerHTML = !deuda ? ''
    : '<b style="color:var(--rojo)">Debe ' + dinero(deuda.debe.CUP, 'CUP') +
      (deuda.debe.USD > 0.005 ? ' y ' + dinero(deuda.debe.USD, 'USD') : '') +
      '</b>, de ' + deuda.ventas.length + ' venta(s). Mientras deba algo no se puede dar de baja.';
  $('velo-cliente').classList.add('abierto');
  if (!c) setTimeout(() => $('cl-nombre').focus(), 120);
}
function cerrarCliente() { $('velo-cliente').classList.remove('abierto'); clienteEditando = null; }

async function guardarCliente() {
  const nombre = $('cl-nombre').value.trim();
  if (nombre.length < 2) { toast('⚠ Ponle nombre al cliente'); $('cl-nombre').focus(); return; }
  try {
    const r = await api('/api/clientes', { method: 'POST', body: JSON.stringify({
      id: clienteEditando || undefined, nombre,
      telefono: $('cl-telefono').value.trim() || null,
      direccion: $('cl-direccion').value.trim() || null,
      nota: $('cl-nota').value.trim() || null }) });
    cerrarCliente();
    await cargarClientes();
    // Recién creado desde la caja, se deja elegido: es para lo que se creó.
    if (!clienteEditando && $('cobro-cliente') &&
        $('velo-cobro').classList.contains('abierto')) {
      $('cobro-cliente').value = r.id;
      pintarFormaCobro();
    }
    if ($('t-porcobrar') && $('t-porcobrar').style.display !== 'none') await cargarPorCobrar();
    toast('✓ Cliente guardado');
  } catch (e) { alert('No se pudo guardar: ' + e.message); }
}

async function darDeBajaCliente() {
  if (!clienteEditando) return;
  if (!confirm('¿Dar de baja a este cliente?\n\nSus ventas no se tocan: siguen contando ' +
               'con su nombre. Solo deja de salir en la lista.')) return;
  try {
    await api('/api/clientes/' + clienteEditando, { method: 'DELETE' });
    cerrarCliente();
    await cargarClientes();
    if ($('t-porcobrar') && $('t-porcobrar').style.display !== 'none') await cargarPorCobrar();
    toast('✓ Cliente dado de baja');
  } catch (e) { alert('No se pudo: ' + e.message); }
}

// ─── Apuntar lo que trae ──────────────────────────────────────
let COBRANDO = null;

async function abrirCobrarVenta(ventaId) {
  try { COBRANDO = await api('/api/ventas/' + ventaId); }
  catch (e) { alert('No se pudo abrir esa venta: ' + e.message); return; }
  const v = COBRANDO.venta;
  $('cv-cabecera').innerHTML = esc(v.cliente || 'Sin cliente') + ' · venta del ' + esc(v.fecha) +
    ' · total ' + dinero(v.total, v.moneda) +
    (v.cobrado > 0.005 ? ' · ya pagó ' + dinero(v.cobrado, v.moneda) : '');
  $('cv-falta').textContent = dinero(v.falta, v.moneda);
  $('cv-importe').value = '';
  $('cv-nota').value = '';
  $('cv-aviso').innerHTML = '';
  $('cv-sitio').innerHTML = SITIOS.map(x =>
    `<option value="${x.id}"${x.id === v.sitio_id ? ' selected' : ''}>${esc(x.nombre)}</option>`).join('');
  // Los pagos que ya trajo, para poder discutirlos con el cliente delante: «el
  // martes trajiste mil» es una conversación que necesita la lista, no el total.
  const hechos = (COBRANDO.cobros || []).filter(c => c.importe > 0 &&
    !(COBRANDO.cobros || []).some(x => x.anula_a === c.id));
  $('cv-apuntes').innerHTML = !hechos.length ? '' :
    '<label class="lbl">Lo que ha ido trayendo</label>' + hechos.map(c => `
      <div class="fila"><span class="pista">${esc(c.fecha)}${
        c.persona ? ' · ' + esc(c.persona) : ''}</span>
        <b class="num">${dinero(c.importe, c.moneda)}</b></div>`).join('');
  $('velo-cobrar').classList.add('abierto');
  setTimeout(() => $('cv-importe').focus(), 120);
}
function cerrarCobrarVenta() { $('velo-cobrar').classList.remove('abierto'); COBRANDO = null; }
function cobrarloTodo() {
  if (!COBRANDO) return;
  $('cv-importe').value = COBRANDO.venta.falta;
}

async function guardarCobroVenta() {
  if (!COBRANDO) return;
  const importe = parseFloat($('cv-importe').value) || 0;
  if (importe <= 0) { toast('⚠ Escribe cuánto trae'); $('cv-importe').focus(); return; }
  try {
    const r = await api('/api/ventas/' + COBRANDO.venta.id + '/cobrar', { method: 'POST',
      body: JSON.stringify({ importe, sitio_id: $('cv-sitio').value,
                             nota: $('cv-nota').value.trim() || null }) });
    cerrarCobrarVenta();
    toast(r.falta > 0.005 ? '✓ Apuntado · le faltan ' + dinero(r.falta, MONEDA)
                          : '✓ Apuntado · esa venta queda saldada');
    await cargarPorCobrar();
    await cargarFondo();
  } catch (e) {
    $('cv-aviso').innerHTML = '<div class="aviso">' + esc(e.message) + '</div>';
  }
}

// El período elegido en la pantalla del Fondo, para que el PDF salga con lo
// mismo que se está viendo.
// ─── El período que se está mirando ──────────────────────────
// Un ANCLA —un día cualquiera de dentro— y el tamaño. Con eso, moverse al mes
// anterior es restarle un mes al ancla, y el rango se vuelve a calcular solo.
// Guardar «desde» y «hasta» sueltos obligaría a recalcular los dos a mano en
// cada salto, y ahí es donde se cuelan los días de más y los de menos.
let PERIODO = { tipo: 'mes', ancla: new Date().toLocaleDateString('sv-SE') };

const aFecha = t => new Date(t + 'T12:00:00');       // mediodía: sin líos de huso
const aISO = d => d.toLocaleDateString('sv-SE');
const finDeMes = t => { const d = aFecha(t); d.setMonth(d.getMonth() + 1, 0); return aISO(d); };

function rangoFondo() {
  const { tipo, ancla } = PERIODO;
  if (tipo === 'dia') return { desde: ancla, hasta: ancla };
  if (tipo === 'semana') {
    // De lunes a domingo. En Cuba la semana empieza el lunes, y una semana que
    // empezara el domingo partiría el fin de semana en dos.
    const d = aFecha(ancla);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const f = aFecha(aISO(d)); f.setDate(f.getDate() + 6);
    return { desde: aISO(d), hasta: aISO(f) };
  }
  if (tipo === 'mes') return { desde: ancla.slice(0, 8) + '01', hasta: finDeMes(ancla) };
  if (tipo === 'ano') return { desde: ancla.slice(0, 4) + '-01-01', hasta: ancla.slice(0, 4) + '-12-31' };
  if (tipo === 'rango') return {
    desde: $('fo-desde').value || '0000-01-01', hasta: $('fo-hasta').value || '9999-12-31' };
  return { desde: '0000-01-01', hasta: '9999-12-31' };
}

function cambiarPeriodo() {
  PERIODO.tipo = $('fo-periodo').value;
  PERIODO.ancla = new Date().toLocaleDateString('sv-SE');   // al cambiar, se vuelve a hoy
  if (PERIODO.tipo === 'rango' && !$('fo-desde').value) {
    const r = { desde: PERIODO.ancla.slice(0, 8) + '01', hasta: PERIODO.ancla };
    $('fo-desde').value = r.desde; $('fo-hasta').value = r.hasta;
  }
  cargarFondo();
}

// Mover el período entero hacia atrás o hacia delante. Es como se mira de
// verdad: «¿y el mes pasado?», «¿y el anterior?».
function moverPeriodo(n) {
  const d = aFecha(PERIODO.ancla);
  if (PERIODO.tipo === 'dia') d.setDate(d.getDate() + n);
  else if (PERIODO.tipo === 'semana') d.setDate(d.getDate() + 7 * n);
  else if (PERIODO.tipo === 'mes') d.setMonth(d.getMonth() + n, 1);
  else if (PERIODO.tipo === 'ano') d.setFullYear(d.getFullYear() + n, 0, 1);
  else return;                       // «entre dos fechas» y «desde el principio» no se mueven
  PERIODO.ancla = aISO(d);
  cargarFondo();
}

// Qué período se está mirando, escrito para leerlo de un vistazo: «agosto de
// 2026», no «del 01-08-2026 al 31-08-2026».
function pintarPeriodo() {
  const r = rangoFondo(), t = PERIODO.tipo;
  const mueve = ['dia', 'semana', 'mes', 'ano'].includes(t);
  $('fo-antes').style.display = mueve ? '' : 'none';
  $('fo-despues').style.display = mueve ? '' : 'none';
  $('fo-fechas').style.display = t === 'rango' ? 'flex' : 'none';
  const dia = f => aFecha(f).toLocaleDateString('es-CU',
    { day: 'numeric', month: 'long', year: 'numeric' });
  const texto = t === 'dia' ? dia(r.desde)
    : t === 'semana' ? 'Del ' + dia(r.desde) + ' al ' + dia(r.hasta)
    : t === 'mes' ? aFecha(r.desde).toLocaleDateString('es-CU', { month: 'long', year: 'numeric' })
    : t === 'ano' ? 'Año ' + r.desde.slice(0, 4)
    : t === 'rango' ? 'Del ' + dia(r.desde) + ' al ' + dia(r.hasta)
    : 'Todo, desde el principio';
  // Se avisa cuando se está mirando algo que todavía no ha pasado: si no, un
  // mes vacío parece un fallo de la aplicación.
  const hoy = new Date().toLocaleDateString('sv-SE');
  $('fo-cual').textContent = texto.charAt(0).toUpperCase() + texto.slice(1) +
    (r.desde > hoy ? ' · todavía no ha empezado' : '');
}

async function cargarFondo() {
  const r = rangoFondo();
  pintarPeriodo();
  try {
    // El desglose por sitio va aparte y CON SU PROPIO catch: si esa puerta se
    // cierra —un cargo sin permiso para verla— no puede llevarse por delante la
    // pantalla entera. Pasaba: al encargado de una tienda, Dinero se le quedaba
    // en blanco y parecía que la aplicación estaba rota (decisión #39).
    const [d, neg] = await Promise.all([
      api('/api/fondo?desde=' + r.desde + '&hasta=' + r.hasta +
          (sitioActual() ? '&sitio=' + encodeURIComponent(sitioActual()) : '') +
          ($('fo-ver-anulados') && $('fo-ver-anulados').checked ? '&anulados=1' : '')),
      api('/api/negocio?desde=' + r.desde + '&hasta=' + r.hasta).catch(() => null)
    ]);
    NEGOCIO = neg;
    FONDO = d;
    // La cifra grande es la de ESTE sitio: es el dinero que quien está aquí
    // puede ir a contar. El del negocio entero va debajo, en pequeño, porque
    // en un punto no dice nada de lo que hay en esa caja —incluye lo de los
    // demás puntos— y sumaba a la confusión.
    // Y quien no puede ver el negocio entero tampoco ve el fondo general: el
    // servidor le manda en «saldo» lo de SUS cajas, y lo avisa con ver_todo. Sin
    // mirar esa marca, la pantalla le diría «en toda la empresa hay 1 200» cuando
    // esos 1 200 son solo los suyos, que es peor que no decir nada.
    const verTodo = d.ver_todo !== false;
    const mio = d.saldo_sitio, propio = !!mio && (!enElMirador() || !verTodo);
    const s = propio ? mio : d.saldo;
    $('fo-titulo-saldo').textContent = propio
      ? 'Efectivo en ' + ((SITIOS.find(x => x.id === sitioActual()) || {}).nombre || 'este sitio')
      : verTodo ? 'Fondo general de la empresa' : 'Efectivo en tus locales';
    $('fo-saldo').textContent = dinero(s.CUP, 'CUP');
    $('fo-saldo-usd').textContent = dinero(s.USD, 'USD');
    $('fo-general').innerHTML = !verTodo
      ? 'Es el dinero de ' + (propio ? 'esta caja' : 'tus locales') +
        '. El de las demás cajas de la empresa no se te enseña.'
      : propio
      ? 'En toda la empresa hay <b>' + dinero(d.saldo.CUP, 'CUP') + '</b>' +
        (d.saldo.USD ? ' y <b>' + dinero(d.saldo.USD, 'USD') + '</b>' : '') +
        ', contando el efectivo de las demás cajas.'
      : 'Es la suma del efectivo de todas las cajas más lo que no es de ningún punto.';
    // Sitio por sitio, y en ningún otro lado. Cada tienda tiene su tarjeta con
    // TODO lo suyo —lo que entró, lo que salió y lo que ganó—, y el negocio
    // entero es la suma, que va al final. Antes esto estaba repartido en tres
    // trozos de la pantalla y para saber qué había hecho una tienda había que
    // juntarlos a ojo.
    //
    // Una tarjeta por sitio y no una tabla ancha: son cinco conceptos en dos
    // monedas más las ganancias, y en un teléfono eso son doce columnas que no
    // se leen.
    //
    // Un sitio en el que no se movió nada, que no guarda dinero y que no ganó
    // nada no sale: no dice nada y aleja del que sí.
    const CONCEPTOS = ['ingreso', 'retiro', 'inversion', 'gasto', 'recibido', 'mandado'];
    const conDinero = (neg.sitios || []).filter(p => p.fondo && p.gaveta && (
      CONCEPTOS.some(t => p.fondo.CUP[t] || p.fondo.USD[t]) ||
      p.gaveta.CUP || p.gaveta.USD ||
      (neg.ver_ganancias && p.vendido)));
    $('fo-sitios').innerHTML = conDinero.length
      ? conDinero.map(p => tarjetaDeSitio(p, neg.ver_ganancias, false)).join('') +
        tarjetaDeSitio(neg.total, neg.ver_ganancias, true)
      : '<div class="vacio" style="padding:16px">Todavía no se movió dinero en ningún sitio.</div>';

    $('fo-cuenta').textContent = d.movimientos.length
      ? d.movimientos.length + (d.movimientos.length === 1 ? ' movimiento' : ' movimientos') +
        ' en el período seleccionado'
      : 'ninguno en el período seleccionado';
    // Cada apunte lleva a la operación que lo creó: la venta, la inversión, el
    // trabajo o el traspaso. Los que se apuntaron a mano no vienen de nada, y
    // esos enseñan quién los apuntó y cuándo.
    $('fo-lista').innerHTML = d.movimientos.length ? d.movimientos.map(m => {
      // Una anulación es el mismo tipo con el importe en negativo, así que el
      // dinero va al revés de lo que dice el tipo: un «retiro» de −100 es dinero
      // que VUELVE. El signo se saca de las dos cosas, no solo del tipo, o la
      // anulación de un retiro saldría en rojo como si hubiera salido otra vez.
      const entra = (m.tipo === 'ingreso') !== (m.importe < 0);
      const signo = entra ? '+' : '−';
      // El apunte que alguien anuló se enseña tachado, y solo se ve si se pide.
      const muerto = m.anulado || m.anula_a;
      return `<div class="mov" onclick="verOrigen('${m.id}')" style="cursor:pointer${
        muerto ? ';opacity:.55' : ''}">
        <div class="ic ${entra ? 'mas' : 'menos'}">${signo}</div>
        <div class="txt"${m.anulado ? ' style="text-decoration:line-through"' : ''}>${
          esc(m.concepto || m.subtipo || m.tipo)}
          <small>${esc(m.tipo)}${m.subtipo ? ' · ' + esc(m.subtipo) : ''}${
            m.sitio ? ' · ' + esc(m.sitio) : ''} · ${esc(m.fecha)}${
            m.anulado ? ' · anulado' : ''}</small></div>
        <div class="imp ${entra ? 'mas' : 'menos'}">${signo}${dinero(Math.abs(m.importe), m.moneda)}</div>
      </div>`;
    }).join('') : '<div class="vacio">Sin movimientos en este período.</div>';
  } catch (e) {
    $('fo-lista').innerHTML = '<div class="vacio">' + e.message + '</div>';
  }
}

// TODO lo que hizo un sitio en el período: el dinero que entró y salió, y lo
// que ganó. Se pinta igual para un almacén, para una tienda y para el total del
// negocio: quien mira quiere comparar, y dos formatos distintos obligan a leer
// dos veces.
function tarjetaDeSitio(p, verGan, esTotal) {
  // 'gaveta' es como manda el servidor el dinero que hay en el sitio; en la
  // pantalla se lee «caja». No son lo mismo: uno es el dato y el otro la
  // palabra. Confundirlos dejó esta tarjeta sin pintarse (14-ago-2026).
  const f = p.fondo, g = p.gaveta || { CUP: 0, USD: 0 };
  const ini = p.gaveta_inicio || { CUP: 0, USD: 0 };
  // Qué fila es esta para el servidor cuando se le pide el desglose de un
  // renglón. Dos de las tres claves no son un id: «*» es el total y «-» es la
  // fila «De la empresa», la del dinero que no se apuntó en ningún punto.
  const clave = esTotal ? '*' : (p.sitio_id || '-');
  // Un concepto que está en cero en las dos monedas no se pinta: llenar la
  // tarjeta de ceros hace que el número que sí importa se pierda entre ellos.
  //
  // Y cada uno se abre para enseñar de qué está hecho: qué ventas fueron esos
  // 166 USD, qué se retiró y quién lo firmó. Antes había que salir a
  // Movimientos y buscarlos a ojo entre todo lo demás del período.
  const linea = (rotulo, campo, color) => {
    const c = f.CUP[campo], u = f.USD[campo];
    if (!c && !u) return '';
    return `<details class="renglon" data-sitio="${esc(clave)}" data-concepto="${campo}"
        ontoggle="abrirDesglose(this)">
      <summary class="fila"><span>${rotulo}</span>
        <b class="num"${color ? ' style="color:' + color + '"' : ''}>${dosMonedas(c, u)}</b></summary>
      <div class="desgl"></div>
    </details>`;
  };
  // Lo que se MOVIÓ en el período: lo que entró (con lo que le pasaron de otro
  // sitio) menos todo lo que salió. Se calcula por moneda, nunca sumando las dos.
  //
  // OJO CON CÓMO SE LLAMA Y DE QUÉ COLOR VA. Esto se llamaba «saldo» y se pintaba
  // en ROJO cuando daba negativo, y las dos cosas engañaban:
  //
  //   · «Saldo» junto al nombre de una tienda se lee como «esto es lo que tiene».
  //     Y no lo es: el dinero que hay está abajo, en «Efectivo en caja». El día
  //     que el dueño filtró por un día vio «-5.508» en rojo y entendió que su
  //     tienda estaba en números rojos, cuando tenía 142.195 en la caja.
  //   · Un período en negativo NO es un fallo: es un día en que salió más dinero
  //     del que entró, que pasa cada vez que se reparten ganancias. El rojo en
  //     esta tarjeta ya significa otra cosa —la caja en negativo, que sí es
  //     imposible— y gastarlo aquí le quitaba fuerza a la señal de verdad.
  //
  // Verde cuando entra más de lo que sale, y color normal cuando no.
  const quedo = m => f[m].ingreso + f[m].recibido -
                     f[m].retiro - f[m].inversion - f[m].gasto - f[m].mandado;

  // Y CON CUÁNTO SE CERRÓ EL PERÍODO. El 29 de agosto de 2026 el dueño lo dijo
  // así: filtrando el día 26 veía «entró 130 y salió 4 638» y quería saber en
  // qué quedaba su caja, que tenía 74 459. Cambiar el rótulo (28-ago) evitó que
  // leyera el flujo como un saldo, pero no le dio el saldo, que era la pregunta.
  //
  // Ahora la tarjeta es un estado de cuenta de la caja:
  //     tenía al empezar  +  lo que entró  −  lo que salió  =  quedó al terminar
  // y el número grande de la cabecera es lo que quedó, que es lo que se fue a
  // buscar. «Entró − salió» sigue estando, en pequeño y en su renglón.
  //
  // Se calcula sumando, NO se pide aparte: así los tres números que se ven en la
  // pantalla cuadran siempre entre ellos. Pedirle al servidor el saldo final por
  // su cuenta podría dar otra cifra y no habría forma de saber cuál miente (#22).
  //
  // Ojo con la tentación de sumarle a los 74 459 lo del día 26: esa cifra es la
  // caja de HOY y ya lleva ese día dentro, así que cada peso contaría dos veces.
  // Lo que se suma es lo que había la VÍSPERA del período.
  const fin = m => ini[m] + quedo(m);
  // Filtrando hasta hoy, «quedó al terminar» y el efectivo que hay ahora son la
  // misma cifra, y enseñarla dos veces seguidas solo hace dudar de si son lo
  // mismo. Mirando un día de atrás sí son distintas, y entonces las dos hacen
  // falta: una es cómo cerró esa noche y la otra lo que hay en la gaveta hoy.
  const cerroComoEsta = fin('CUP') === g.CUP && fin('USD') === g.USD;
  // 'ingreso' es el total de las tres entradas de arriba, asi que no hace falta
  // mirarlo aparte para saber si aqui no paso nada.
  const nada = ['ingreso', 'retiro', 'inversion', 'gasto', 'recibido', 'mandado']
    .every(t => !f.CUP[t] && !f.USD[t]);

  // Las ganancias del sitio, dentro de su misma tarjeta. Estaban en otra tabla
  // más abajo, y para saber qué había hecho una tienda había que juntar dos
  // sitios de la pantalla a ojo.
  const hayGanancias = verGan && (p.vendido || p.costo);
  const ganancias = !hayGanancias ? '' : `
    <div class="fila" style="border-top:1.5px solid var(--borde);margin-top:9px;padding-top:9px">
      <span style="color:var(--texto3);font-size:12.5px">Vendiendo por el mostrador</span>
      <b class="num" style="font-size:14px">${p.tipo === 'negocio' ? '—'
        : enBase(p.vendido - p.costo)}</b></div>
    <div class="fila">
      <span style="font-weight:700">Ganancia</span>
      <b class="num" style="color:var(--acento-osc)">${
        esTotal ? conRef(p.ganancia) : enBase(p.ganancia)}</b></div>
    <!-- Y lo que cuesta la gente de ese sitio, restado de su ganancia (#33). Las
         comisiones son las que generaron sus ventas; los salarios, los apuntados
         en su caja. Solo sale si hay algo que restar: una fila que dice «menos
         cero» en cada tienda es ruido. -->
    ${p.comision || p.sueldos ? `
      <div class="fila">
        <span style="color:var(--texto3);font-size:12.5px">− Comisiones</span>
        <b class="num" style="font-size:14px">${enBase(p.comision)}</b></div>
      <div class="fila">
        <span style="color:var(--texto3);font-size:12.5px">− Salarios y adelantos</span>
        <b class="num" style="font-size:14px">${enBase(p.sueldos)}</b></div>
      <div class="fila">
        <span style="font-weight:700">Queda</span>
        <b class="num" style="color:var(--marca-claro)">${
          esTotal ? conRef(p.queda) : enBase(p.queda)}</b></div>` : ''}`;

  // Una caja en negativo no existe: significa que falta un apunte o que
  // alguien se equivocó de sitio o de moneda al apuntar algo. Se dice, en vez
  // de enseñar un número raro y dejar que cada uno se lo explique. Vale igual
  // para la de hoy y para cómo cerró el período: las dos son cajas.
  const enRojo = g.CUP < 0 || g.USD < 0 || fin('CUP') < 0 || fin('USD') < 0;
  const colorCaja = enRojo ? 'var(--rojo)' : 'var(--marca-claro)';
  const colorFlujo = quedo('CUP') >= 0 && quedo('USD') >= 0
    ? 'var(--marca-claro)' : 'var(--texto2)';

  return `<details class="tarjeta plegable" style="margin-bottom:10px${
      esTotal ? ';border-color:var(--marca-claro)' : ''}"${esTotal ? ' open' : ''}>
    <summary>
      <div class="nmPleg">${esTotal ? 'TOTAL DE LA EMPRESA' : esc(p.sitio)}
        <small>${esTotal ? 'La suma de todos los sitios'
          : (p.tipo === 'almacen' ? 'almacén' : p.tipo === 'negocio' ? 'sin punto' : 'punto') +
            ' · en caja hoy ' + dosMonedas(g.CUP, g.USD)}</small></div>
      <div class="cifPleg" style="color:${colorCaja}">${dosMonedas(fin('CUP'), fin('USD'))}
        <div style="font-weight:500;font-size:11px;color:var(--texto3)">${
          cerroComoEsta ? 'lo que hay en la caja' : 'quedó al terminar'}</div></div>
    </summary>
    <div class="cuerpoPleg">
    ${nada ? '<div class="pista" style="margin:0">No se movió dinero aquí en este período. La caja ' +
        'sigue con los <b>' + dosMonedas(fin('CUP'), fin('USD')) + '</b> con que empezó.</div>'
      : `<div class="fila" style="border-bottom:1.5px solid var(--borde)">
          <span style="font-weight:700">Tenía al empezar</span>
          <b class="num">${dosMonedas(ini.CUP, ini.USD)}</b></div>` +
        linea('Ingresos por ventas', 'de_ventas', 'var(--marca-claro)') +
        linea('Otros ingresos', 'de_otros', 'var(--marca-claro)') +
        linea('Recibido de otro sitio', 'recibido') +
        linea('Retiros', 'retiro') +
        linea('Inversiones', 'inversion') +
        linea('Gastos', 'gasto') +
        linea('Mandado a otro sitio', 'mandado') +
        `<div class="fila">
          <span style="color:var(--texto3);font-size:12.5px">Entró menos salió, en este período</span>
          <b class="num" style="font-size:14px;color:${colorFlujo}">${
            dosMonedas(quedo('CUP'), quedo('USD'))}</b></div>
        <div class="fila" style="border-top:1.5px solid var(--borde);margin-top:5px;padding-top:9px">
          <span style="font-weight:700">Quedó al terminar</span>
          <b class="num" style="color:${colorCaja}">${dosMonedas(fin('CUP'), fin('USD'))}</b>
        </div>`}
    ${ganancias}
    ${cerroComoEsta && !nada ? '' : `<div class="fila" style="border:0">
      <span style="color:var(--texto3);font-size:12.5px">Efectivo en caja hoy</span>
      <b class="num" style="font-size:14px${enRojo ? ';color:var(--rojo)' : ''}">${
        dosMonedas(g.CUP, g.USD)}</b></div>`}
    ${enRojo ? '<div class="aviso" style="text-align:left;margin:0">Esta caja está en ' +
      '<b>negativo</b>, y eso no puede ser: de ahí ha salido más dinero del que entró. ' +
      'Casi siempre es un movimiento cargado al sitio equivocado, o en la moneda equivocada. ' +
      'Míralo en Movimientos.</div>' : ''}
    </div>
  </details>`;
}
// ─── De qué está hecho un renglón ─────────────────────────────
// Se pide al ABRIR y no antes. Una tarjeta tiene hasta ocho renglones y en la
// pantalla hay cinco tarjetas: cargarlo todo de entrada son cuarenta consultas
// para enseñar algo que casi nadie va a abrir, y en un teléfono con la conexión
// de allá eso se nota.
//
// Y se pide UNA sola vez: lo que ya se trajo se queda puesto, que cerrar y
// volver a abrir no es volver a preguntar. Si la consulta falla se borra la
// marca, para que el segundo intento sí salga.
async function abrirDesglose(d) {
  if (!d.open || d.dataset.hecho) return;
  d.dataset.hecho = '1';
  const caja = d.querySelector('.desgl');
  caja.innerHTML = '<div class="pista" style="margin:6px 0">Buscando…</div>';
  // El período es el mismo de la pantalla, sacado de donde lo saca todo lo
  // demás: si se guardara aquí una copia, cambiar el filtro dejaría los
  // renglones ya abiertos enseñando lo de antes.
  const r = rangoFondo();
  try {
    const x = await api('/api/negocio/desglose' +
      '?concepto=' + encodeURIComponent(d.dataset.concepto) +
      '&sitio_id=' + encodeURIComponent(d.dataset.sitio) +
      '&desde=' + r.desde + '&hasta=' + r.hasta);
    caja.innerHTML = pintarDesglose(x);
  } catch (e) {
    d.dataset.hecho = '';
    caja.innerHTML = '<div class="pista" style="margin:6px 0">' + esc(e.message) + '</div>';
  }
}

// Cada apunte con lo que se pueda decir de él sin abrir otra pantalla: de una
// venta, los productos que llevaba con su cantidad y su precio; de una compra,
// su número y su nombre; de un traspaso, con qué caja fue.
//
// El importe va SIEMPRE con su moneda al lado, la del apunte. Los precios de
// las líneas están en esa misma moneda —es lo que el cliente pagó—, así que se
// escriben con ella y no con la del negocio.
function pintarDesglose(x) {
  if (!x.apuntes.length)
    return '<div class="pista" style="margin:6px 0">Ningún apunte en este período.</div>';
  const cuerpo = x.apuntes.map(a => {
    const de = a.de || {};
    // Un apunte anulado y el contrario que lo anula suman cero, y los dos
    // cuentan arriba. Se enseñan tachados, no escondidos: si se quitaran, este
    // desglose no sumaría lo que dice el renglón.
    const muerto = a.anulado || a.anula_a;
    let pie = a.fecha;
    if (a.sitio && x.sitio_id === '*') pie += ' · ' + a.sitio;
    if (a.persona) pie += ' · ' + a.persona;
    if (de.tipo === 'venta' && de.cliente) pie += ' · ' + de.cliente;
    if (de.tipo === 'inversion') pie += ' · compra ' + (de.numero || '') +
      (de.proveedor ? ' · ' + de.proveedor : '');
    if (de.tipo === 'traspaso' && de.otra_caja)
      pie += (a.tipo === 'ingreso' ? ' · de ' : ' · a ') + de.otra_caja;
    if (a.anulado) pie += ' · anulado';
    if (a.anula_a) pie += ' · anula a otro';

    const titulo = a.concepto ||
      (de.tipo === 'inversion' ? (de.nombre || 'Compra de mercancía')
       : de.tipo === 'venta' ? 'Venta' : a.subtipo || a.tipo);
    const productos = de.tipo === 'venta' && de.lineas && de.lineas.length
      ? de.lineas.map(l => `<div class="prod">
          <span>${esc(l.nombre)} · ${l.cantidad}${l.um ? ' ' + esc(l.um) : ''} × ${
            dinero(l.precio_unit, a.moneda)}</span>
          <b>${dinero(l.importe, a.moneda)}</b></div>`).join('')
      : '';
    return `<div class="ap${muerto ? ' muerto' : ''}">
        <span>${esc(titulo)}<small>${esc(pie)}</small></span>
        <b>${dinero(Math.abs(a.importe), a.moneda)}${a.importe < 0 ? ' (al revés)' : ''}</b>
      </div>${productos}`;
  }).join('');
  // El total de abajo tiene que dar el mismo número que el renglón de arriba, y
  // por eso lo suma el servidor de la tabla entera y no de los apuntes que
  // mandó: si un período largo se corta, el total sigue siendo el de verdad y se
  // avisa de que la lista está cortada.
  //
  // Con UN solo apunte no se pone: «4 638 · Suman 4 638» es el mismo número dos
  // veces seguidas, y eso no aclara nada, solo hace dudar de si son dos cosas.
  const suma = x.apuntes.length === 1 && !x.hay_mas ? ''
    : `<div class="ap" style="border-top:1.5px solid var(--borde);font-weight:700">
        <span>Suman${x.hay_mas ? ' (los ' + x.cuantos + ', no solo los de arriba)' : ''}</span>
        <b>${dosMonedas(x.total.CUP, x.total.USD)}</b></div>`;
  return cuerpo + suma +
    (x.hay_mas ? '<div class="pista">Se enseñan los ' + x.apuntes.length +
      ' más recientes de ' + x.cuantos + '. Para verlos todos, acorta el período.</div>' : '');
}

// Las dos monedas, una al lado de la otra y con un «+» que no es una suma: son
// dos cifras distintas que no se pueden juntar (DECISIONES.md #21).
const dosMonedas = (cup, usd) => !cup && !usd ? dinero(0, MONEDA_BASE)
  : [cup ? dinero(cup, 'CUP') : '', usd ? dinero(usd, 'USD') : ''].filter(Boolean).join('  +  ');

// ═══════════════════════════════════════════════════════════════
//  BORRAR DATOS
// ═══════════════════════════════════════════════════════════════
// Se ha estado probando la aplicación con datos inventados y hay que empezar
// con los de verdad. Eso es lo que esto resuelve, y por eso existe aunque vaya
// contra la regla de que los apuntes no se borran (DECISIONES.md #2 y #29).
//
// La pantalla enseña CUÁNTO hay de cada cosa antes de borrar nada: «¿seguro?»
// no es una pregunta si uno no sabe qué se está llevando por delante.
let BORRABLE = null;

async function cargarBorrado() {
  const caja = $('tarjeta-borrar');
  if (!caja) return;
  // Solo el administrador. El servidor lo rechaza igual, pero enseñarle el
  // botón a quien no puede usarlo solo sirve para que lo intente.
  if (!puedo('*')) { caja.hidden = true; return; }
  try { BORRABLE = await api('/api/borrar/vista-previa'); }
  catch (e) { caja.hidden = true; return; }
  caja.hidden = false;
  $('bo-aviso-sync').style.display = BORRABLE.hay_otras_copias ? 'block' : 'none';
  $('bo-grupos').innerHTML = BORRABLE.grupos.map(g => `
    <label class="casilla">
      <input type="checkbox" value="${esc(g.id)}" onchange="revisarBorrado()">
      <span><b>${esc(g.nombre)}</b> · ${g.cuantos ? g.cuantos + (g.cuantos === 1 ? ' registro' : ' registros')
        : 'nada que borrar'}<small>${esc(g.detalle)}</small></span>
    </label>`).join('');
  revisarBorrado();
}

const gruposMarcados = () => [...document.querySelectorAll('#bo-grupos input:checked')]
  .map(i => i.value);

// Marcar «el catálogo» sin marcar las ventas dejaría apuntes de productos que
// ya no existen. En vez de dejar que el servidor lo rechace después, se marcan
// solas las que hacen falta y se dice por qué.
function revisarBorrado() {
  if (!BORRABLE) return;
  let marcados = gruposMarcados();
  const arrastrados = [];
  for (const id of marcados) {
    const g = BORRABLE.grupos.find(x => x.id === id);
    for (const nec of (g.exige || [])) if (!marcados.includes(nec)) {
      const casilla = document.querySelector('#bo-grupos input[value="' + nec + '"]');
      if (casilla) { casilla.checked = true; arrastrados.push(nec); }
    }
  }
  if (arrastrados.length) marcados = gruposMarcados();
  const palabra = ($('bo-palabra').value || '').trim().toUpperCase() === 'BORRAR';
  $('bo-btn').disabled = !marcados.length || !palabra;
  $('bo-btn').textContent = marcados.length
    ? 'Borrar ' + marcados.length + (marcados.length === 1 ? ' cosa' : ' cosas')
    : 'Borrar lo marcado';
  if (arrastrados.length) toast('También hace falta borrar: ' + arrastrados
    .map(a => (BORRABLE.grupos.find(g => g.id === a) || {}).nombre).join(', '));
}

async function borrarDatos() {
  const grupos = gruposMarcados();
  if (!grupos.length) return;
  const nombres = grupos.map(id => (BORRABLE.grupos.find(g => g.id === id) || {}).nombre);
  // Dos confirmaciones y la palabra escrita. Puede parecer demasiado; borrar
  // el histórico de un negocio por un dedo torpe lo es más.
  if (!confirm('Se va a borrar:\n\n· ' + nombres.join('\n· ') +
      '\n\nNo se puede deshacer desde la aplicación. Se hará una copia de seguridad ' +
      'automática justo antes.\n\n¿Seguir?')) return;
  if (!confirm('Última pregunta.\n\n¿Borrar de verdad ' + nombres.length +
      (nombres.length === 1 ? ' cosa' : ' cosas') + '?')) return;
  const b = $('bo-btn');
  b.disabled = true; b.textContent = 'Borrando…';
  try {
    const r = await api('/api/borrar', { method: 'POST', body: JSON.stringify({
      grupos, confirmacion: $('bo-palabra').value.trim() }) });
    const total = Object.values(r.borrado).reduce((s, n) => s + n, 0);
    $('bo-resultado').innerHTML = '<div class="aviso" style="text-align:left">Borrado: <b>' +
      total + (total === 1 ? ' registro' : ' registros') + '</b>.<br>La copia de seguridad se llama <b>' +
      esc(r.copia) + '</b> y está en la lista de arriba.</div>';
    $('bo-palabra').value = '';
    // Se recarga todo: dejar en pantalla listas de cosas que ya no existen es
    // la forma más rápida de que alguien piense que no se borró nada.
    await cargarCatalogo();
    cargarBorrado();
    toast('✓ Borrado');
  } catch (e) {
    alert(e.message);
  } finally { b.textContent = 'Borrar lo marcado'; revisarBorrado(); }
}

// ─── Repasar los costos ───────────────────────────────────────
// Arregla lo que dejó escrito el fallo del 12 al 14 de agosto de 2026: el costo
// tecleado en una moneda y guardado como si fuera la otra. El servidor no
// inventa nada —propone lo que costó según la inversión con la que entró, o
// deshace la conversión de más—, y aquí se puede escribir el número a mano, que
// es lo que manda. Ver /api/costos/repasar en server.js.
let COSTOS_RAROS = null;

async function repasarCostos() {
  const cont = $('rc-lista');
  cont.innerHTML = '<div class="vacio">Buscando…</div>';
  $('rc-pie').style.display = 'none';
  $('rc-resultado').innerHTML = '';
  try {
    const d = await api('/api/costos/repasar');
    COSTOS_RAROS = d;
    if (!d.productos.length) {
      cont.innerHTML = '<div class="vacio">Ningún producto dice costar más de lo que se ' +
        'vende. No hay nada que corregir.</div>';
      return;
    }
    cont.innerHTML = d.productos.map((p, i) => `
      <div class="tarjeta" style="margin:10px 0;border-color:var(--rojo)">
        <label class="casilla">
          <input type="checkbox" data-i="${i}"
                 ${p.propuesto != null ? 'checked' : ''} onchange="revisarCostos()">
          <span><b>${esc(p.nombre)}</b>${p.codigo ? ' · ' + esc(p.codigo) : ''}
            <small>Se vende a ${dinero(p.precio, p.precio_moneda)} y dice costar
            ${enBase(p.costo)}${p.veces > 1 ? ' — <b>' + p.veces + ' veces más</b>' : ''}</small></span>
        </label>
        <label class="lbl">Costo bueno, en ${esc(d.moneda_base)}</label>
        <input type="number" data-i="${i}" step="0.01" inputmode="decimal"
               value="${p.propuesto != null ? p.propuesto : ''}" placeholder="Escríbelo tú">
        ${p.opciones.map(o => `<button class="btn" style="margin-top:6px;width:100%"
            onclick="ponerCosto(${i}, ${o.costo})">${esc(o.texto)}:
            <b>${dinero(o.costo, d.moneda_base)}</b></button>`).join('')}
        ${p.opciones.length ? '' : '<div class="pista">Este producto nunca entró por una ' +
          'inversión y no hay valor del dólar puesto, así que no hay de dónde sacar el costo ' +
          'bueno. Escríbelo tú.</div>'}
        <div class="pista">Con él se corrigen ${p.arrastre.movimientos} apunte(s) del
          inventario y ${p.arrastre.ventas} venta(s).</div>
      </div>`).join('');
    $('rc-pie').style.display = '';
    revisarCostos();
  } catch (e) { cont.innerHTML = '<div class="aviso">' + esc(e.message) + '</div>'; }
}

// Se busca por el TIPO de casilla y no por una clase inventada: una clase sin
// estilo detrás casi siempre es una errata, y el banco de pantallas la caza.
const casillaCosto = i =>
  document.querySelector('#rc-lista input[type="number"][data-i="' + i + '"]');

function ponerCosto(i, valor) {
  const inp = casillaCosto(i);
  if (inp) { inp.value = valor; revisarCostos(); }
}

function revisarCostos() {
  const palabra = ($('rc-palabra').value || '').trim().toUpperCase() === 'CORREGIR';
  const n = costosMarcados().length;
  $('rc-btn').disabled = !n || !palabra;
  $('rc-btn').textContent = n
    ? 'Corregir ' + n + (n === 1 ? ' producto' : ' productos') : 'Corregir lo marcado';
}

// Solo los marcados Y con un costo escrito: una casilla marcada con la casilla
// del número en blanco no se manda, en vez de que el servidor la rechace y no se
// corrija ninguna.
function costosMarcados() {
  if (!COSTOS_RAROS) return [];
  const fuera = [];
  document.querySelectorAll('#rc-lista input[type="checkbox"]').forEach(m => {
    if (!m.checked) return;
    const i = Number(m.dataset.i);
    const inp = casillaCosto(i);
    const costo = parseFloat(inp && inp.value);
    if (costo > 0) fuera.push({ producto_id: COSTOS_RAROS.productos[i].id, costo,
                                nombre: COSTOS_RAROS.productos[i].nombre });
  });
  return fuera;
}

async function corregirCostos() {
  const correcciones = costosMarcados();
  if (!correcciones.length) return toast('⚠ Ponle un costo a lo que marcaste');
  if (!confirm('Se va a corregir el costo de:\n\n· ' +
      correcciones.map(c => c.nombre + ' → ' + c.costo).join('\n· ') +
      '\n\nCambia también la ganancia de las ventas que lo usaron. Se hará ' +
      'una copia de seguridad automática justo antes.\n\n¿Seguir?')) return;
  const b = $('rc-btn');
  b.disabled = true; b.textContent = 'Corrigiendo…';
  try {
    const r = await api('/api/costos/corregir', { method: 'POST', body: JSON.stringify({
      correcciones: correcciones.map(c => ({ producto_id: c.producto_id, costo: c.costo })),
      confirmacion: $('rc-palabra').value.trim() }) });
    $('rc-resultado').innerHTML = '<div class="aviso" style="text-align:left">Corregidos <b>' +
      r.hecho.productos + '</b> producto(s), <b>' + r.hecho.movimientos + '</b> apunte(s) del ' +
      'inventario y <b>' + r.hecho.ventas + '</b> venta(s).' +
      '<br>La copia de seguridad se llama <b>' + esc(r.copia) +
      '</b>.</div>';
    $('rc-palabra').value = '';
    await cargarCatalogo();
    await repasarCostos();      // lo corregido ya no sale: así se ve que entró
    toast('✓ Costos corregidos');
  } catch (e) {
    alert(e.message);
  } finally { revisarCostos(); }
}

// ─── De dónde salió un apunte ────────────────────────────────
// Tocar un movimiento y llegar a la operación que lo creó. Se enseña aquí en
// vez de saltar a otra pantalla porque la venta puede ser de otro día y de otro
// sitio, y llevar a alguien a Cierre con la fecha cambiada es peor que
// enseñarle lo que quería ver.
async function verOrigen(id) {
  $('velo-origen').classList.add('abierto');
  $('or-titulo').textContent = 'El movimiento';
  $('or-cuerpo').innerHTML = '<div class="vacio">Buscando…</div>';
  let d;
  try { d = await api('/api/fondo/' + id); }
  catch (e) { $('or-cuerpo').innerHTML = '<div class="vacio">' + esc(e.message) + '</div>'; return; }

  const a = d.apunte, o = d.origen;
  // Como en la lista: una anulación lleva el importe en negativo, y entonces el
  // dinero va al contrario de lo que dice el tipo.
  const entra = (a.tipo === 'ingreso') !== (a.importe < 0);
  const fila = (k, v) => v ? `<div class="fila"><span>${k}</span><b>${v}</b></div>` : '';
  let detalle = '', boton = '';
  APUNTE_ABIERTO = a;

  if (o && o.tipo === 'venta') {
    const v = o.venta;
    $('or-titulo').textContent = 'Venta de origen';
    detalle = fila('Fecha', fechaHora(v.ts || v.creado_en)) +
      fila('Sitio', esc(v.sitio || '—')) + fila('Vendedor', esc(v.persona || '—')) +
      fila('Cliente', v.cliente ? esc(v.cliente) : '') +
      fila('Total', dinero(v.total, v.moneda)) +
      (v.anulada_en ? '<div class="aviso" style="text-align:left">Esta venta está <b>anulada</b>.</div>' : '') +
      (o.lineas.length ? '<h2 style="margin:14px 0 6px">Detalle de la venta</h2>' +
        o.lineas.map(l => `<div class="fila"><span>${esc(l.nombre || '—')}</span>
          <b>${Math.abs(l.cantidad)} ${esc(l.um || '')} × ${dinero(l.precio_unit, v.moneda)}</b></div>`).join('')
        : '');

  } else if (o && o.tipo === 'inversion') {
    const i = o.inversion;
    $('or-titulo').textContent = 'Inversión de origen';
    detalle = fila('Número', esc(i.numero || '—')) + fila('Nombre', esc(i.nombre || '—')) +
      fila('Proveedor', i.proveedor ? esc(i.proveedor) : '') +
      fila('Fecha', esc(i.fecha || '—')) + fila('Estado', esc(i.estado));
    boton = `<button class="btn acento ancho" onclick="cerrarOrigen();verInversion('${i.id}')">
      Ver la inversión</button>`;

  } else if (o && o.tipo === 'traspaso') {
    $('or-titulo').textContent = 'Transferencia entre sitios';
    detalle = o.mitades.map(m => `<div class="fila">
      <span>${m.tipo === 'ingreso' ? 'Entró en' : 'Salió de'} <b>${esc(m.sitio || '—')}</b></span>
      <b class="num" style="color:${m.tipo === 'ingreso' ? 'var(--marca-claro)' : 'var(--rojo)'}">
        ${m.tipo === 'ingreso' ? '+' : '−'}${dinero(m.importe, m.moneda)}</b></div>`).join('') +
      '<div class="pista">El dinero no salió del negocio: cambió de caja. Por eso el saldo ' +
      'general no se movió.</div>';

  } else {
    // Apuntado a mano. No viene de ninguna operación, y decirlo es la respuesta:
    // si no, uno se queda buscando un origen que no existe.
    $('or-titulo').textContent = a.anula_a ? 'Anulación' : 'Registrado manualmente';
    detalle = '<div class="pista" style="margin-top:0">' + (a.anula_a
      ? 'Este apunte anula a otro: deja su importe en cero sin borrar nada. Los dos ' +
        'están en el histórico y se ven marcando «Ver también los anulados».'
      : 'Este movimiento no procede de ninguna venta ni de ninguna inversión: se ' +
        'registró a mano en el fondo.') + '</div>' +
      fila('Registrado por', a.persona ? esc(a.persona) : '—') +
      fila('Fecha de registro', fechaHora(a.creado_en));
  }

  // Corregir y quitar. Solo los apuntes hechos a mano, y lo decide el servidor:
  // el que viene de una venta o de una inversión se deshace en su pantalla, y si
  // se pulsara igual, el servidor lo dice con todas sus letras.
  if (d.se_puede_tocar) {
    boton += `<div class="btnFila" style="margin-top:12px">
      <button class="btn" style="flex:1" onclick="corregirApunte()">Editar</button>
      <button class="btn peligro" style="flex:1" onclick="quitarApunte()">Quitar</button>
    </div>`;
  } else if (d.anulado) {
    boton += '<div class="aviso" style="text-align:left;margin-top:12px">Este apunte está ' +
      '<b>anulado</b>: ya no cuenta en ninguna cuenta.</div>';
  }

  $('or-cuerpo').innerHTML = `
    <div class="fila" style="border-bottom:1.5px solid var(--borde)">
      <span>${esc(a.concepto || a.subtipo || a.tipo)}<br>
        <small style="color:var(--texto3)">${esc(a.tipo)}${a.subtipo ? ' · ' + esc(a.subtipo) : ''}
          ${a.sitio ? ' · ' + esc(a.sitio) : ' · del negocio'} · ${esc(a.fecha)}</small></span>
      <b class="num" style="color:${entra ? 'var(--marca-claro)' : 'var(--rojo)'}">${
        entra ? '+' : '−'}${dinero(Math.abs(a.importe), a.moneda)}</b></div>
    ${detalle}${boton}`;
}
function cerrarOrigen() { $('velo-origen').classList.remove('abierto'); }

// ─── Apuntar en el fondo ──────────────────────────────────────
// ─── Pasar dinero de una caja a otra ───────────────────────
// No es un retiro: el dinero no sale del negocio, cambia de sitio. Se apunta
// como dos mitades y el fondo general no se mueve.
function abrirTraspaso() {
  const activos = SITIOS.filter(s => s.activo !== 0);
  if (activos.length < 2) return toast('⚠ Hace falta más de un sitio para poder pasar dinero');
  const ops = activos.map(s => `<option value="${s.id}">${esc(s.nombre)}</option>`).join('');
  $('tr-origen').innerHTML = ops;
  $('tr-destino').innerHTML = ops;
  $('tr-origen').value = sitioActual() || activos[0].id;
  // El destino arranca en otro distinto: dejar los dos iguales solo sirve para
  // que el servidor conteste que no.
  $('tr-destino').value = (activos.find(s => s.id !== $('tr-origen').value) || activos[0]).id;
  $('tr-importe').value = '';
  $('tr-concepto').value = '';
  $('tr-moneda').value = MONEDA_BASE;
  pintarSaldoTraspaso();
  $('velo-traspaso').classList.add('abierto');
}
function cerrarTraspaso() { $('velo-traspaso').classList.remove('abierto'); }

// Cuánto hay de verdad en la caja de la que se quiere sacar. Sin esto, el
// importe se escribe a ciegas y el error solo aparece al guardar.
function pintarSaldoTraspaso() {
  const id = $('tr-origen').value, m = $('tr-moneda').value;
  const g = ((FONDO && FONDO.gavetas) || []).find(x => x.sitio_id === id);
  const hay = g ? g[m] || 0 : 0;
  $('tr-hay').innerHTML = 'Saldo disponible: <b>' + dinero(hay, m) + '</b>.';
}

async function guardarTraspaso() {
  const importe = parseFloat($('tr-importe').value) || 0;
  if (importe <= 0) { toast('⚠ Pon el importe'); $('tr-importe').focus(); return; }
  if ($('tr-origen').value === $('tr-destino').value)
    return toast('⚠ El origen y el destino son el mismo sitio');
  try {
    await api('/api/fondo/traspaso', { method: 'POST', body: JSON.stringify({
      origen_id: $('tr-origen').value, destino_id: $('tr-destino').value,
      moneda: $('tr-moneda').value, importe, concepto: $('tr-concepto').value.trim() }) });
    cerrarTraspaso();
    toast('✓ Transferencia registrada');
    cargarFondo();
  } catch (e) { alert(e.message); }
}

function abrirFondo(tipo, apunte) {
  fondoTipo = tipo;
  fondoEditando = apunte ? apunte.id : null;
  const titulos = { retiro: 'Retiro de fondos', inversion: 'Inversión',
                    gasto: 'Gasto', ingreso: 'Ingreso' };
  const pistas = {
    retiro: 'Dinero que sale de la empresa: salarios de dirección, reparto de utilidades.',
    inversion: 'Dinero que sale para hacer crecer la empresa. Hay que declarar el concepto, siempre.',
    gasto: 'Dinero que se va en mantener la operación en marcha.',
    ingreso: 'Dinero que entra por un concepto que no es una venta.'
  };
  $('fo-titulo').textContent = titulos[tipo];
  $('fo-pista').textContent = pistas[tipo];
  $('fo-importe').value = '';
  $('fo-concepto').value = '';
  // Empieza en la moneda del negocio y no en pesos. Cada casilla de moneda
  // que arrancaba en CUP era una forma de apuntar veinte dólares como veinte
  // pesos sin enterarse: pasó, y dejó una caja en negativo.
  $('fo-moneda').value = MONEDA_BASE;
  $('fo-subtipo').innerHTML = (tipo === 'inversion' ? '<option value="">Elige…</option>' : '') +
    SUBTIPOS[tipo].map(s => `<option>${esc(s)}</option>`).join('');
  $('fo-subtipo-lbl').textContent = tipo === 'inversion' ? 'Tipo de inversión *' : 'Tipo';
  // En qué caja pasa el dinero. SIEMPRE hay que decirlo, también en el ingreso:
  // hasta el 31 de agosto de 2026 aquí había un «Ninguno en concreto» y se quitó.
  // El dinero entra en una caja de verdad, y no decir cuál dejaba esa gaveta sin
  // contar un dinero que sí está dentro — el mismo fallo de la #37, visto por el
  // otro lado. El servidor lo rechaza igual (#10).
  const entra = tipo === 'ingreso';
  $('fo-sitio-lbl').textContent = entra ? 'Entra en la caja de *' : 'Sale de la caja de *';
  $('fo-sitio').innerHTML = '<option value="">Elige…</option>' +
    SITIOS.map(s => `<option value="${s.id}">${esc(s.nombre)}</option>`).join('');
  // Viene puesta la caja del sitio en el que se está trabajando, que es por donde
  // pasa el dinero nueve de cada diez veces.
  if (SITIOS.some(s => s.id === sitioActual())) $('fo-sitio').value = sitioActual();
  // La pista de debajo la escribe pintarCajaFondo(), al final: dice lo mismo y
  // además cuánto hay en la caja elegida.
  // Una inversión EN MERCANCÍA no se apunta aquí: se hace en su pantalla, con
  // la lista de lo que se compró. Esto es para la otra clase de inversión —una
  // camioneta, un local, herramientas—, que no se recupera vendiendo unidades.
  $('fo-aviso').innerHTML = tipo === 'inversion'
    ? '<div class="aviso">Si lo que compraste es <b>mercancía para vender</b>, apúntalo en ' +
      '<b>Dinero → Inversiones</b>: allí pones los productos y se ve cuánto vas recuperando. ' +
      'Esto es para lo demás: equipos, local, transporte.</div>' : '';
  $('fo-fecha').value = new Date().toLocaleDateString('sv-SE');
  $('fo-guardar').textContent = 'Registrar';

  // «Esto es dinero para la gente», solo en lo que SALE. Viene marcado de
  // antemano cuando el tipo de apunte ya lo dice —un salario es un salario—, para
  // que no dependa de que alguien se acuerde de marcarlo.
  const puedeSerGente = tipo === 'retiro' || tipo === 'gasto';
  $('fo-gente-caja').style.display = puedeSerGente ? 'block' : 'none';
  $('fo-es-gente').checked = false;
  $('fo-beneficiario').innerHTML = '<option value="">Sin decir quién</option>' +
    (PERSONAS.length ? PERSONAS : []).filter(p => p.activo)
      .map(p => `<option value="${p.id}">${esc(p.nombre)}</option>`).join('');
  if (puedeSerGente) {
    const s = $('fo-subtipo');
    s.onchange = alElegirSubtipoFondo;
    alElegirSubtipoFondo();
  }

  // Corrigiendo uno que ya existe: entra tal como está y se cambia lo que haga
  // falta. Por dentro no se reescribe nada —se anula el viejo y se apunta el
  // nuevo—, pero eso no tiene por qué saberlo quien lo está arreglando.
  if (apunte) {
    $('fo-titulo').textContent = 'Corregir el ' + (titulos[tipo] || tipo).toLowerCase();
    $('fo-pista').textContent = 'Se apunta corregido. El apunte de antes queda anulado ' +
      'en el histórico, no se borra.';
    $('fo-guardar').textContent = 'Guardar la corrección';
    $('fo-importe').value = Math.abs(apunte.importe);
    $('fo-concepto').value = apunte.concepto || '';
    $('fo-moneda').value = apunte.moneda === 'USD' ? 'USD' : 'CUP';
    $('fo-sitio').value = apunte.sitio_id || '';
    $('fo-fecha').value = apunte.fecha || '';
    // El subtipo que tenía puede no estar en la lista de este tipo (se apuntó
    // con otro nombre, o el tipo cambió). Si no está, se añade: perderlo sin
    // avisar sería cambiarle el apunte por detrás.
    const sel = $('fo-subtipo');
    if (apunte.subtipo) {
      if (![...sel.options].some(o => o.value === apunte.subtipo))
        sel.insertAdjacentHTML('beforeend', `<option>${esc(apunte.subtipo)}</option>`);
      sel.value = apunte.subtipo;
    }
    // Corrigiendo: entra tal como está apuntado, incluida la marca. Es la única
    // forma de arreglar un salario que se apuntó sin marcar.
    $('fo-es-gente').checked = !!apunte.es_gente;
    $('fo-beneficiario').value = apunte.beneficiario_id || '';
  }
  alMarcarGente();
  pintarCajaFondo();
  $('velo-fondo').classList.add('abierto');
  setTimeout(() => $('fo-importe').focus(), 120);
}

// Lo que hay en la caja elegida, debajo del desplegable. Solo en el dinero que
// SALE: en un ingreso el saldo de antes no hace falta para nada, y un número de
// más en la pantalla es un número que alguien va a leer como si importara.
// Si no dejan ver el fondo no llegan las gavetas y no se enseña saldo ninguno,
// que es mejor que enseñar un cero que parece uno de verdad (decisión #38).
function pintarCajaFondo() {
  // La pista dice dos cosas distintas según por dónde va el dinero. En lo que
  // SALE, el aviso que importa es que no se puede sacar más de lo que hay (#38).
  // En un INGRESO no hay tope ninguno —se está metiendo—, así que enseñar «no se
  // puede sacar más» ahí sería un aviso que no viene a cuento; lo útil es con
  // cuánto se queda esa caja.
  const entra = fondoTipo === 'ingreso';
  const base = entra
    ? 'Hay que decir en qué caja entra: es lo que hace que esa gaveta cuadre con el '
      + 'dinero que tiene dentro de verdad.'
    : 'Hay que decir de qué caja sale: es lo que hace que la gaveta de ese sitio '
      + 'cuadre con el dinero que tiene dentro de verdad.';
  const id = $('fo-sitio').value;
  const gav = (FONDO && FONDO.gavetas) || null;
  if (!id || !gav) { $('fo-sitio-pista').textContent = base; return; }
  const g = gav.find(x => x.sitio_id === id), m = $('fo-moneda').value;
  const hay = g ? g[m] || 0 : 0;
  if (!entra) {
    $('fo-sitio-pista').innerHTML = 'En esa caja hay <b>' + dinero(hay, m) +
      '</b>. No se puede sacar más de lo que hay.';
    return;
  }
  const suma = parseFloat($('fo-importe').value) || 0;
  $('fo-sitio-pista').innerHTML = 'En esa caja hay <b>' + dinero(hay, m) + '</b>' +
    (suma ? ', y con esto quedarán <b>' + dinero(hay + suma, m) + '</b>.' : '.');
}
function cerrarFondo() { $('velo-fondo').classList.remove('abierto'); fondoEditando = null; }

// El «¿a quién?» solo tiene sentido si es dinero para la gente.
function alMarcarGente() {
  $('fo-quien-caja').style.display = $('fo-es-gente').checked ? 'block' : 'none';
}

// Los tipos de apunte que YA dicen que es dinero para la gente se marcan solos.
// Depender de que alguien se acuerde de marcar la casilla es depender de que un
// mes salga bien y el siguiente no, sin saber cuál de los dos miente.
function alElegirSubtipoFondo() {
  if (fondoEditando) return;            // corrigiendo manda lo que está apuntado
  const s = ($('fo-subtipo').value || '').toLowerCase();
  if (/salari|comisi|adelanto|sueldo/.test(s)) $('fo-es-gente').checked = true;
  alMarcarGente();
}

async function guardarFondo() {
  const importe = parseFloat($('fo-importe').value) || 0;
  if (importe <= 0) { toast('⚠ Pon el importe'); $('fo-importe').focus(); return; }
  const subtipo = $('fo-subtipo').value;
  if (fondoTipo === 'inversion' && !subtipo) {
    $('fo-aviso').innerHTML = '<div class="aviso">Toda inversión tiene que declarar de qué tipo es.</div>';
    return;
  }
  // El dinero que sale tiene que decir de qué caja (#37). Se comprueba aquí para
  // avisar antes de mandarlo, y el servidor lo vuelve a comprobar igual.
  if (['retiro', 'gasto', 'inversion'].includes(fondoTipo) && !$('fo-sitio').value) {
    $('fo-aviso').innerHTML = '<div class="aviso">Di <b>de qué caja sale el dinero</b>. ' +
      'Sin eso, la gaveta de ese sitio seguiría diciendo que tiene un dinero que ya no está.</div>';
    $('fo-sitio').focus();
    return;
  }
  try {
    const cuerpo = {
      tipo: fondoTipo, subtipo, importe, moneda: $('fo-moneda').value,
      concepto: $('fo-concepto').value.trim(),
      sitio_id: $('fo-sitio').value || null,
      es_gente: $('fo-es-gente').checked,
      beneficiario_id: ($('fo-es-gente').checked && $('fo-beneficiario').value) || null,
      fecha: $('fo-fecha').value || new Date().toLocaleDateString('sv-SE')
    };
    // Corregir tiene su propia dirección porque no es lo mismo: allí se anula
    // el apunte viejo y se mete el nuevo, las dos cosas o ninguna.
    const r = await api(fondoEditando ? '/api/fondo/' + fondoEditando + '/corregir' : '/api/fondo',
      { method: 'POST', body: JSON.stringify(cuerpo) });
    const corregido = !!fondoEditando;
    cerrarFondo();
    toast((corregido ? '✓ Corregido. Quedan ' : '✓ Registrado. Quedan ') +
          dinero(r.saldo.CUP, 'CUP') +
          (r.saldo.USD ? ' y ' + dinero(r.saldo.USD, 'USD') : ''));
    await cargarFondo();
  } catch (e) {
    // El cartel, y además escrito en la propia pantalla: al cerrar el aviso hay
    // que poder seguir leyendo por qué no se pudo, con el importe delante para
    // corregirlo. Pasa sobre todo con «no hay ese dinero en esa caja» (#38).
    $('fo-aviso').innerHTML = '<div class="aviso">' + esc(e.message) + '</div>';
    alert('No se pudo registrar: ' + e.message);
  }
}

// ─── Corregir o quitar un apunte del fondo ────────────────────
// Los dos salen de la ficha del movimiento, y los dos van contra el apunte que
// se está mirando. Están aquí y no en la lista para que haya que abrirlo antes:
// quitar un apunte de dinero de un tirón, sin haber visto lo que es, es
// exactamente como se borra lo que no se quería borrar.
function corregirApunte() {
  const a = APUNTE_ABIERTO;
  if (!a) return;
  cerrarOrigen();
  abrirFondo(a.tipo, a);
}

async function quitarApunte() {
  const a = APUNTE_ABIERTO;
  if (!a) return;
  if (!confirm('¿Quitar este apunte de ' + dinero(Math.abs(a.importe), a.moneda) + '?\n\n' +
      (a.concepto || a.subtipo || a.tipo) + ' · ' + a.fecha + '\n\n' +
      'Deja de contar en el saldo y en los informes. No se borra: queda en el ' +
      'histórico marcado como anulado.')) return;
  try {
    const r = await api('/api/fondo/' + a.id + '/anular', { method: 'POST', body: '{}' });
    cerrarOrigen();
    toast('✓ Anulado. Quedan ' + dinero(r.saldo.CUP, 'CUP') +
          (r.saldo.USD ? ' y ' + dinero(r.saldo.USD, 'USD') : ''));
    await cargarFondo();
  } catch (e) { alert('No se pudo quitar: ' + e.message); }
}

// ═══════════════════════════════════════════════════════════════
//  INVERSIONES: qué se compró, dónde se puso y cuánto se ha recuperado
// ═══════════════════════════════════════════════════════════════
// Ninguna cifra de esta pantalla está guardada: se suman de las compras y de
// las ventas de esos mismos productos (DECISIONES.md #1 y #18). Por eso siempre
// cuadran con el inventario y con el fondo.

let INVERSIONES = [];
let invEditando = null;
let IV_LINEAS = [];        // [{producto_id, nombre, codigo, cantidad, costo_unit, reparto:[]}]
let CUENTAS = null;        // las cuentas de la inversión que se está mirando

const monedaInv = () => $('iv-moneda').value === 'USD' ? 'USD' : 'CUP';

async function cargarInversiones() {
  const todas = $('iv-filtro').value === 'todas';
  let d;
  try { d = await api('/api/inversiones' + (todas ? '?todas=1' : '')); }
  catch (e) { $('iv-lista').innerHTML = '<div class="vacio">' + e.message + '</div>'; return; }
  INVERSIONES = d.inversiones || [];
  if (!INVERSIONES.length) {
    $('iv-lista').innerHTML = '<div class="vacio">Todavía no hay inversiones.<br>' +
      'La primera es la lista de lo que compraste.</div>';
    return;
  }
  $('iv-lista').innerHTML = INVERSIONES.map(i => {
    const pct = i.pct_costo;
    const ancho = pct === null || pct === undefined ? 0 : Math.max(0, Math.min(100, pct));
    const borrador = i.estado === 'borrador';
    return `<div class="proy" onclick="${borrador
        ? `abrirInversion('${i.id}')` : `verInversion('${i.id}')`}">
      <div class="cab">
        <div class="nm">${esc(i.nombre)}</div>
        ${i.estado !== 'registrada' ? '<span class="chip">' + esc(i.estado) + '</span>' : ''}
      </div>
      <div class="cli">${esc(i.numero || '')} · ${esc(i.fecha)}</div>
      ${!d.cifras ? '<div class="cli">Sin permiso para ver las cifras.</div>' : `
      <div class="cifras">
        <div><small>Costó</small><b>${dinero(i.importe, i.moneda)}</b></div>
        <div><small>Recuperado del costo</small><b class="ok">${dinero(i.costo_recuperado, i.moneda)}</b></div>
      </div>
      ${borrador ? '<div class="cli">Sin registrar: la mercancía todavía no ha entrado.</div>' : `
      <div class="barra"><i class="${ancho >= 100 ? 'lleno' : ''}" style="width:${ancho}%"></i></div>
      <div class="cli">${pct === null ? 'Sin unidades' : 'Va por el ' + pct + '% del costo'} ·
        ganancia ${dinero(i.extra, i.moneda)} ·
        ${i.unidades_vendidas} de ${i.unidades} unidades vendidas${
        i.pendiente ? ' · ' + dinero(i.pendiente, i.moneda) + ' entregado sin cobrar' : ''}</div>`}`}
    </div>`;
  }).join('');
}

// ─── El papel de la inversión ─────────────────────────────────
async function abrirInversion(id) {
  invEditando = id || null;
  const i = id ? INVERSIONES.find(x => x.id === id) : null;
  // De qué caja sale. Solo cajas de verdad: se quitó la opción que lo sacaba del
  // montón, porque ese montón no es ninguna gaveta que se pueda ir a contar
  // (decisión #38) — y por eso la prueba busca que esa opción no esté. Viene
  // puesta la del sitio en el que se está trabajando, que es de donde sale el
  // dinero nueve de cada diez veces.
  $('iv-sitio').innerHTML = '<option value="">Elige…</option>' +
    SITIOS.map(s => `<option value="${s.id}">${esc(s.nombre)}</option>`).join('');
  $('iv-sitio').value = (i && i.sitio_id)
    || (SITIOS.some(s => s.id === sitioActual()) ? sitioActual() : '');
  $('iv-titulo').textContent = i ? 'Inversión ' + (i.numero || '') : 'Nueva inversión';
  $('iv-nombre').value = i ? i.nombre : '';
  $('iv-proveedor').value = (i && i.proveedor) || '';
  $('iv-nota').value = (i && i.nota) || '';
  $('iv-moneda').value = (i && i.moneda) || MONEDA_BASE;
  $('iv-fecha').value = (i && i.fecha) || new Date().toLocaleDateString('sv-SE');
  $('iv-busq').value = '';
  $('iv-resultados').innerHTML = '';
  $('iv-aviso').innerHTML = '';
  $('iv-borrar').style.display = i ? 'block' : 'none';
  IV_LINEAS = [];
  $('velo-inversion').classList.add('abierto');
  renderLineasInversion();
  if (i) cargarLineasInversion(id); else setTimeout(() => $('iv-nombre').focus(), 120);
}
// Al cerrar la ventana se vuelve a preguntar al servidor. Parece de más y no lo
// es: el 13 de agosto una inversión se registró de verdad en la copia de
// internet y la pantalla del teléfono se quedó enseñando «Todavía no hay
// inversiones». La orden llegó, la respuesta se perdió por el camino —eso pasa
// con el internet de un teléfono— y el refresco de la lista iba DESPUÉS de esa
// línea, así que nunca corrió. Manda lo que diga el servidor, nunca lo que la
// pantalla creía saber.
function cerrarInversion() {
  $('velo-inversion').classList.remove('abierto');
  cargarInversiones();
}

// Un fallo se enseña en dos sitios: dentro de la ventana, donde se estaba
// mirando, y como aviso flotante, porque el hueco de los avisos está al final
// de una ventana larga y en un teléfono queda fuera de la pantalla. Y se
// refresca la lista: si lo que falló fue la respuesta y no la orden, la
// inversión ya existe y hay que verla.
function falloInversion(e) {
  $('iv-aviso').innerHTML = '<div class="aviso">' + esc(e.message) + '</div>';
  toast('⚠ ' + e.message.split('\n')[0]);
  cargarInversiones();
}

async function cargarLineasInversion(id) {
  try {
    const d = await api('/api/inversiones/' + id);
    IV_LINEAS = (d.lineas || []).map(l => ({
      producto_id: l.producto_id, nombre: l.nombre, codigo: l.codigo,
      descripcion: l.descripcion, cantidad: l.cantidad, costo_unit: l.costo_unit,
      reparto: (l.reparto || []).map(r => ({ sitio_id: r.sitio_id, cantidad: r.cantidad }))
    }));
    renderLineasInversion();
  } catch (e) { $('iv-aviso').innerHTML = '<div class="aviso">' + esc(e.message) + '</div>'; }
}

function alaInversion(id) {
  const p = PRODUCTOS.find(x => x.id === id);
  if (!p) return;
  if (IV_LINEAS.find(l => l.producto_id === id)) { toast('⚠ Ese producto ya está en la lista'); return; }
  // El costo que se propone es el que ya tenía el producto, pasado a la moneda
  // de la compra. Casi nunca es el bueno, pero ahorra teclear el orden de magnitud.
  const c = convertir(p.costo || 0, MONEDA_BASE, monedaInv());
  IV_LINEAS.push({ producto_id: id, nombre: p.nombre, codigo: p.codigo, cantidad: 1,
                   costo_unit: c === null ? 0 : (monedaInv() === 'USD' ? Math.round(c * 100) / 100 : Math.round(c)),
                   reparto: [] });
  $('iv-busq').value = '';
  $('iv-resultados').innerHTML = '';
  renderLineasInversion();
}

// Añadir dinero que no es mercancía: el transporte, un ayudante, la comida de
// la obra. Por dentro es una línea sin producto, con cantidad 1, para que el
// importe siga saliendo de multiplicar cantidad por costo y no haya dos formas
// de calcular lo mismo (decisión #18).
function anadirDineroInv() {
  IV_LINEAS.push({ producto_id: null, descripcion: '', cantidad: 1, costo_unit: 0, reparto: [] });
  renderLineasInversion();
  setTimeout(() => {
    const c = document.querySelectorAll('#iv-lineas .lineaInv input[data-concepto]');
    if (c.length) c[c.length - 1].focus();
  }, 60);
}
function ponerConceptoInv(i, valor) { IV_LINEAS[i].descripcion = valor; }

function renderLineasInversion() {
  const m = monedaInv();
  $('iv-lineas').innerHTML = IV_LINEAS.map((l, i) => {
    // Línea de DINERO: ni cantidad, ni reparto entre sitios. Solo en qué se fue
    // y cuánto. Enseñarle a alguien un «a dónde va» para el transporte de una
    // obra sería pedirle que conteste una pregunta que no significa nada.
    if (!l.producto_id) return `<div class="lineaInv">
      <div class="cab">
        <div class="nm">Gasto suelto<small>no entra en el inventario</small></div>
        <button class="quitar" onclick="IV_LINEAS.splice(${i},1);renderLineasInversion()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <label class="lbl">En qué se fue</label>
      <input type="text" data-concepto="1" value="${esc(l.descripcion || '')}"
             placeholder="Ej: transporte, ayudante, comida"
             onchange="ponerConceptoInv(${i}, this.value)">
      <label class="lbl">Cuánto (${m})</label>
      <input type="number" inputmode="decimal" value="${l.costo_unit || ''}"
             onchange="ponerLineaInv(${i},'costo_unit',this.value)">
    </div>`;
    const repartido = (l.reparto || []).reduce((s, r) => s + (Number(r.cantidad) || 0), 0);
    const sinRepartir = Math.max(0, l.cantidad - repartido);
    return `<div class="lineaInv">
      <div class="cab">
        <div class="nm">${esc(l.nombre)}<small>${esc(l.codigo || '')}</small></div>
        <button class="quitar" onclick="IV_LINEAS.splice(${i},1);renderLineasInversion()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="dosCol">
        <div><label class="lbl">Cantidad</label>
          <input type="number" inputmode="decimal" value="${l.cantidad}"
                 onchange="ponerLineaInv(${i},'cantidad',this.value)"></div>
        <div><label class="lbl">Costo por unidad (${m})</label>
          <input type="number" inputmode="decimal" value="${l.costo_unit}"
                 onchange="ponerLineaInv(${i},'costo_unit',this.value)"></div>
      </div>
      <div class="fila"><span>Importe</span><b class="num">${dinero(l.cantidad * l.costo_unit, m)}</b></div>
      <label class="lbl">A dónde va</label>
      ${SITIOS.map(s => {
        const r = (l.reparto || []).find(x => x.sitio_id === s.id);
        return `<div class="sitioPrecio">
          <span class="nmS">${esc(s.nombre)}</span>
          <input type="number" inputmode="decimal" placeholder="0" value="${r ? r.cantidad : ''}"
                 onchange="repartirLinea(${i},'${s.id}',this.value)">
        </div>`;
      }).join('')}
      <div class="pista">${sinRepartir > 0
        ? sinRepartir + ' sin repartir: se quedan en el almacén principal.'
        : repartido > l.cantidad ? '<b style="color:var(--rojo)">Estás repartiendo ' +
          repartido + ' de ' + l.cantidad + '.</b>' : 'Todo repartido.'}</div>
    </div>`;
  }).join('') || '<div class="pista">Todavía no has puesto nada: busca un producto arriba, ' +
    'o añade dinero si lo que sacaste no es mercancía.</div>';

  const total = IV_LINEAS.reduce((s, l) => s + l.cantidad * l.costo_unit, 0);
  const prods = IV_LINEAS.filter(l => l.producto_id);
  const uds = prods.reduce((s, l) => s + Number(l.cantidad || 0), 0);
  const sueltas = IV_LINEAS.length - prods.length;
  $('iv-importe').textContent = dinero(total, m);
  const otra = convertir(total, m, m === 'USD' ? 'CUP' : 'USD');
  const partes = [];
  if (prods.length) partes.push(uds + ' unidades en ' + prods.length +
    (prods.length === 1 ? ' producto' : ' productos'));
  if (sueltas) partes.push(sueltas + (sueltas === 1 ? ' movimiento de dinero' : ' movimientos de dinero'));
  if (otra !== null && total) partes.push('son ' + dinero(otra, m === 'USD' ? 'CUP' : 'USD') +
    ' al valor del dólar de hoy');
  $('iv-desglose').textContent = partes.join(' · ');
  // El importe acaba de cambiar, así que lo que hay en la caja hay que volver a
  // compararlo con él.
  pintarCajaInversion();
}

// Cuánto hay de verdad en la caja de la que va a salir el dinero, y si llega.
// Sin esto el importe se escribe a ciegas y el «no tienes ese dinero» solo
// aparece al registrar, con la inversión entera ya tecleada. Es lo mismo que se
// hace en el pase entre cajas, que ya avisaba antes de guardar.
//
// Las gavetas vienen de /api/fondo, que se pide al abrir Dinero. Si a quien
// mira no le dejan ver el fondo no llega ninguna: entonces no se enseña nada,
// que es mejor que enseñar un cero que parece un saldo.
function pintarCajaInversion() {
  const id = $('iv-sitio').value, m = monedaInv();
  const gav = (FONDO && FONDO.gavetas) || null;
  if (!id) {
    $('iv-sitio-pista').innerHTML = 'Elige de qué caja sale: la tienda, el almacén o la ' +
      'brigada. Es lo que hace que esa gaveta cuadre con el dinero que tiene dentro.';
    return;
  }
  if (!gav) { $('iv-sitio-pista').textContent = ''; return; }
  const g = gav.find(x => x.sitio_id === id);
  const hay = g ? g[m] || 0 : 0;
  const total = IV_LINEAS.reduce((s, l) => s + l.cantidad * l.costo_unit, 0);
  $('iv-sitio-pista').innerHTML = 'En esa caja hay <b>' + dinero(hay, m) + '</b>.' +
    (total > hay + 0.0001
      ? ' <b style="color:var(--rojo)">Faltan ' + dinero(total - hay, m) + ' para esta compra.</b>' +
        ' Apunta primero el dinero que entró, o pásalo desde otra caja.'
      : '');
}

function ponerLineaInv(i, campo, valor) {
  IV_LINEAS[i][campo] = parseFloat(valor) || 0;
  renderLineasInversion();
}
function repartirLinea(i, sitioId, valor) {
  const c = parseFloat(valor) || 0;
  const rep = IV_LINEAS[i].reparto = (IV_LINEAS[i].reparto || []).filter(r => r.sitio_id !== sitioId);
  if (c > 0) rep.push({ sitio_id: sitioId, cantidad: c });
  renderLineasInversion();
}

function cuerpoInversion() {
  return {
    id: invEditando || undefined,
    nombre: $('iv-nombre').value.trim(),
    proveedor: $('iv-proveedor').value.trim() || null,
    nota: $('iv-nota').value.trim() || null,
    moneda: monedaInv(),
    sitio_id: $('iv-sitio').value || null,
    fecha: $('iv-fecha').value || new Date().toLocaleDateString('sv-SE'),
    lineas: IV_LINEAS.map(l => ({ producto_id: l.producto_id || null,
      descripcion: l.descripcion || null, cantidad: l.cantidad,
      costo_unit: l.costo_unit, reparto: l.reparto || [] }))
  };
}

async function guardarInversion(callado) {
  const c = cuerpoInversion();
  if (c.nombre.length < 2) { toast('⚠ Ponle nombre'); $('iv-nombre').focus(); return false; }
  // De qué caja sale ya no se puede dejar en blanco (decisión #38). Se para aquí
  // además de en el servidor para no hacer ir y volver por algo que se ve en la
  // propia pantalla.
  if (!c.sitio_id) { toast('⚠ Di de qué caja sale el dinero'); $('iv-sitio').focus(); return false; }
  try {
    const r = await api('/api/inversiones', { method: 'POST', body: JSON.stringify(c) });
    invEditando = r.id;
    $('iv-borrar').style.display = 'block';
    if (!callado) { toast('✓ Borrador guardado'); cerrarInversion(); }
    return true;
  } catch (e) {
    falloInversion(e);
    return false;
  }
}

async function registrarInversion() {
  if (!IV_LINEAS.length) { toast('⚠ Pon al menos un producto'); return; }
  if (!await guardarInversion(true)) return;
  const uds = IV_LINEAS.reduce((s, l) => s + Number(l.cantidad || 0), 0);
  // El aviso dice de QUÉ CAJA sale, no «del fondo»: el dinero sale de una gaveta
  // concreta y quien confirma tiene que poder darse cuenta si se equivocó de sitio.
  const caja = (SITIOS.find(s => s.id === $('iv-sitio').value) || {}).nombre || 'el fondo';
  if (!confirm('Se va a meter la mercancía en el inventario y a sacar ' +
      dinero(IV_LINEAS.reduce((s, l) => s + l.cantidad * l.costo_unit, 0), monedaInv()) +
      ' de la caja de ' + caja + '.\n\n' + uds +
      ' unidades.\n\nDespués ya no se podrá cambiar: solo cancelar. ¿Seguimos?')) return;
  try {
    await api('/api/inversiones/' + invEditando + '/registrar', { method: 'POST',
      body: JSON.stringify({ actualizar_costos: $('iv-costos').checked }) });
    toast('✓ Inversión registrada');
    cerrarInversion();              // esto ya vuelve a pedir la lista
    await cargarCatalogo();
  } catch (e) { falloInversion(e); }
}

async function borrarInversion() {
  if (!invEditando || !confirm('¿Borrar este borrador? Todavía no ha pasado nada, así que no se pierde ningún dato del negocio.')) return;
  try {
    await api('/api/inversiones/' + invEditando, { method: 'DELETE' });
    toast('✓ Borrado');
    cerrarInversion();
  } catch (e) { falloInversion(e); }
}

// ─── Cómo va una inversión ────────────────────────────────────
async function verInversion(id) {
  $('velo-inv-cuentas').classList.add('abierto');
  $('ic-cuerpo').innerHTML = '<div class="vacio">Sacando las cuentas…</div>';
  try { CUENTAS = await api('/api/inversiones/' + id); }
  catch (e) { $('ic-cuerpo').innerHTML = '<div class="vacio">' + e.message + '</div>'; return; }
  pintarCuentasInversion();
}

function cerrarInvCuentas() { $('velo-inv-cuentas').classList.remove('abierto'); }

function pintarCuentasInversion() {
  const d = CUENTAS, i = d.inversion, m = i.moneda;
  const pct = d.pct_costo === null ? 0 : Math.max(0, Math.min(100, d.pct_costo));
  $('ic-titulo').textContent = i.nombre;
  $('ic-sub').textContent = [i.numero, i.fecha, i.proveedor, i.estado !== 'registrada' ? i.estado : '']
    .filter(Boolean).join(' · ');
  $('ic-cancelar').style.display = i.estado === 'cancelada' ? 'none' : '';
  const fila = (k, v, clase) => `<div class="fila"><span>${k}</span>
    <b class="num ${clase || ''}">${v}</b></div>`;

  $('ic-cuerpo').innerHTML = `
    <div class="tarjeta">
      <h2>Cómo va</h2>
      ${fila('Costó', dinero(d.importe, m))}
      ${fila('Recuperado del costo', dinero(d.costo_recuperado, m), 'ok')}
      ${fila('Ganancia encima', dinero(d.extra, m), 'ok')}
      ${d.pendiente ? fila('Entregado y sin cobrar', dinero(d.pendiente, m)) : ''}
      ${d.perdido ? fila('Perdido en mermas', dinero(d.perdido, m)) : ''}
      <div class="barra" style="margin-top:10px"><i class="${pct >= 100 ? 'lleno' : ''}"
        style="width:${pct}%"></i></div>
      <div class="pista">${d.pct_costo === null ? 'Sin unidades que seguir.'
        : 'Se ha recuperado el <b>' + d.pct_costo + '%</b> de lo que costó. Lo de encima ya es ' +
          'ganancia limpia: ' + dinero(d.extra, m) + '.'}
        ${d.sin_tasa ? '<br><b>Ojo:</b> hay ventas en la otra moneda y falta el valor del ' +
          'dólar en Ajustes, así que esas no están contadas.' : ''}</div>
      ${d.recuperada_el ? '<div class="pista">Quedó recuperada en ' + esc(d.recuperada_el) + '.</div>' : ''}
      ${d.ritmo && d.ritmo.fecha_estimada ? '<div class="pista">A lo que ha entrado en estos ' +
        d.ritmo.dias + ' días (' + dinero(d.ritmo.por_dia, m) + ' al día), lo que falta se ' +
        'recupera hacia el <b>' + d.ritmo.fecha_estimada + '</b>. Es una cuenta a ojo: si las ' +
        'ventas cambian, la fecha cambia.</div>' : ''}
    </div>

    <div class="tarjeta">
      <h2>En qué se fue</h2>
      <div class="tablaCont"><table class="tabla">
        <thead><tr><th>Concepto</th><th class="n">Cant.</th><th class="n">Costo</th>
          <th class="n">Importe</th></tr></thead>
        <tbody>${d.lineas.map(l => `<tr>
          <td>${esc(l.nombre || '(borrado)')}${l.es_dinero
            ? '<br><span style="font-size:10.5px;color:var(--texto3)">dinero, no mercancía</span>'
            : (l.reparto && l.reparto.length
              ? '<br><span style="font-size:10.5px;color:var(--texto3)">' +
                l.reparto.map(r => esc(r.sitio || '') + ' ' + r.cantidad).join(' · ') + '</span>' : '')}</td>
          <td class="n">${l.es_dinero ? '—' : l.cantidad}</td>
          <td class="n">${l.es_dinero ? '—' : dinero(l.costo_unit, m)}</td>
          <td class="n">${dinero(l.cantidad * l.costo_unit, m)}</td></tr>`).join('')}
        </tbody>
        <tfoot><tr><td>Total</td><td class="n">${d.unidades || '—'}</td><td></td>
          <td class="n">${dinero(d.importe, m)}</td></tr></tfoot>
      </table></div>
      ${d.unidades ? `<div class="pista">Vendidas ${d.unidades_vendidas} · quedan ${d.unidades_quedan}${
        d.unidades_perdidas ? ' · ' + d.unidades_perdidas + ' perdidas en mermas' : ''}</div>` : ''}
    </div>

    ${d.linea.length ? `<div class="tarjeta">
      <h2>Mes a mes</h2>
      <div class="tablaCont"><table class="tabla">
        <thead><tr><th>Mes</th><th class="n">Entró</th><th class="n">Repone costo</th>
          <th class="n">Ganancia</th><th class="n">% del costo</th></tr></thead>
        <tbody>${d.linea.map(x => `<tr><td>${esc(x.mes)}</td>
          <td class="n">${dinero(x.importe, m)}</td><td class="n">${dinero(x.costo, m)}</td>
          <td class="n">${dinero(x.ganancia, m)}</td>
          <td class="n">${x.pct === null ? '—' : x.pct + '%'}</td></tr>`).join('')}
        </tbody></table></div>
      <div class="pista">El porcentaje es del costo, y va acumulado: es el mismo de arriba.</div>
    </div>` : ''}

    <div class="tarjeta">
      <h2>De dónde sale cada peso</h2>
      ${d.eventos.length ? d.eventos.slice().reverse().map(e => fila(
        esc(e.texto || 'Venta') +
        (e.unidades ? ' · ' + e.unidades + ' u.' : '') + ' · ' + esc(e.fecha),
        '+' + dinero(e.importe, m), 'ok')).join('')
        : '<div class="vacio" style="padding:16px">Todavía no se ha vendido nada de esta compra.</div>'}
    </div>`;
}

async function cancelarInversion() {
  if (!CUENTAS) return;
  if (!confirm('Cancelar la inversión saca del inventario la mercancía que entró con ella y ' +
      'devuelve el dinero al fondo.\n\nNo se borra nada: quedan los movimientos contrarios, ' +
      'a la vista.\n\n¿Seguimos?')) return;
  try {
    await api('/api/inversiones/' + CUENTAS.inversion.id + '/cancelar', { method: 'POST' });
    cerrarInvCuentas();
    toast('✓ Cancelada');
    await cargarCatalogo();
    await cargarInversiones();
  } catch (e) { alert('No se pudo cancelar: ' + e.message); }
}

function imprimirInversion() {
  if (!CUENTAS) { toast('⚠ Espera a que carguen las cuentas'); return; }
  const d = CUENTAS, i = d.inversion, m = i.moneda;
  const kv = (k, x, f) => `<div class="kv${f ? ' fuerte' : ''}"><span>${k}</span><span>${x}</span></div>`;
  lanzarImpresion(
    cabeceraPDF('Inversión ' + (i.numero || ''),
      [i.nombre, i.fecha, i.proveedor].filter(Boolean).join(' · ')) +
    `<h2>En qué se fue</h2><table>
      <thead><tr><th>Concepto</th><th>Dónde está</th><th class="n">Cant.</th>
        <th class="n">Costo</th><th class="n">Importe</th></tr></thead>
      <tbody>${d.lineas.map(l => `<tr><td>${esc(l.nombre || '(borrado)')}</td>
        <td>${l.es_dinero ? 'dinero, no mercancía'
          : ((l.reparto || []).map(r => esc(r.sitio || '') + ' ' + r.cantidad).join(', ') || '—')}</td>
        <td class="n">${l.es_dinero ? '—' : l.cantidad}</td>
        <td class="n">${l.es_dinero ? '—' : dinero(l.costo_unit, m)}</td>
        <td class="n">${dinero(l.cantidad * l.costo_unit, m)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="2">Total</td><td class="n">${d.unidades}</td><td></td>
        <td class="n">${dinero(d.importe, m)}</td></tr></tfoot></table>
     <h2>Cómo va</h2>
     ${kv('Costó', dinero(d.importe, m))}
     ${kv('Recuperado del costo', dinero(d.costo_recuperado, m) +
        (d.pct_costo === null ? '' : '  (' + d.pct_costo + '%)'))}
     ${kv('Ganancia encima', dinero(d.extra, m))}
     ${d.pendiente ? kv('Entregado y sin cobrar', dinero(d.pendiente, m)) : ''}
     ${kv('Unidades vendidas', d.unidades_vendidas + ' de ' + d.unidades, true)}
     <div class="nota">Lo recuperado se cuenta de las ventas de estos mismos productos, según
       se van vendiendo. Lo que entra repone primero el costo; lo que pasa de ahí es ganancia.</div>` +
    (d.linea.length ? `<h2>Mes a mes</h2><table>
      <thead><tr><th>Mes</th><th class="n">Entró</th><th class="n">Repone costo</th>
        <th class="n">Ganancia</th><th class="n">% del costo</th></tr></thead>
      <tbody>${d.linea.map(x => `<tr><td>${esc(x.mes)}</td>
        <td class="n">${dinero(x.importe, m)}</td><td class="n">${dinero(x.costo, m)}</td>
        <td class="n">${dinero(x.ganancia, m)}</td>
        <td class="n">${x.pct === null ? '—' : x.pct + '%'}</td></tr>`).join('')}</tbody></table>` : '') +
    piePDF());
}

// ═══════════════════════════════════════════════════════════════
//  COPIAS DE SEGURIDAD
// ═══════════════════════════════════════════════════════════════
// Se hacen solas, pero se enseñan: una salva que nadie ha mirado nunca es una
// salva en la que no se puede confiar el día que hace falta.
let SALVAS = [];

async function cargarSalvas() {
  if (!puedo('copias')) return;
  let d;
  try { d = await api('/api/salvas'); }
  catch (e) { $('sa-lista').innerHTML = '<div class="pista">' + esc(e.message) + '</div>'; return; }
  SALVAS = d.salvas || [];
  // Sin decir DÓNDE se guardan: una ruta de la máquina no le sirve de nada a quien
  // lee esto, y no tiene por qué ver las tripas de la aplicación. Lo que sí le
  // sirve —bajarse una copia— está aquí mismo, en la lista de abajo.
  $('sa-nota').textContent = 'Se guarda una copia entera al arrancar y cada ' + d.cada_horas +
    ' horas. Se conservan las ' + d.guardar + ' últimas, guardadas a buen recaudo dentro de la propia aplicación. ' +
    'Toca el tamaño de cualquiera para bajarte esa copia.';
  const kb = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB';
  const cuando = s => {
    const t = new Date(s.cuando);
    const horas = (Date.now() - t.getTime()) / 3600000;
    return t.toLocaleString('es-CU', { day: '2-digit', month: '2-digit', hour: '2-digit',
                                       minute: '2-digit' }) +
      (horas < 1 ? ' · hace un rato' : horas < 48 ? ' · hace ' + Math.round(horas) + ' h' : '');
  };
  $('sa-lista').innerHTML = SALVAS.length
    ? SALVAS.slice(0, 6).map((s, i) => `<div class="fila">
        <span>${cuando(s)}${i === 0 ? ' <b>(la última)</b>' : ''}</span>
        <b class="num"><a href="#" onclick="bajarSalva('${s.archivo}');return false"
          style="color:var(--marca-claro)">${kb(s.bytes)}</a></b></div>`).join('') +
      (SALVAS.length > 6 ? '<div class="pista">Y ' + (SALVAS.length - 6) + ' más.</div>' : '')
    : '<div class="aviso">Todavía no hay ninguna copia. Dale a «Salvar ahora».</div>';
}

async function salvarAhora() {
  toast('Salvando…');
  try {
    const r = await api('/api/salvas', { method: 'POST' });
    toast('✓ Copia guardada');
    await cargarSalvas();
  } catch (e) { alert('No se pudo salvar: ' + e.message); }
}

// Se abre en una pestaña con el token en la dirección porque una descarga no
// puede llevar la cabecera de la sesión.
function bajarSalva(archivo) {
  const a = document.createElement('a');
  a.href = '/api/salvas/' + archivo + '?token=' + encodeURIComponent(token());
  a.download = archivo;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
function bajarUltimaSalva() {
  if (!SALVAS.length) { toast('⚠ Todavía no hay ninguna copia'); return; }
  bajarSalva(SALVAS[0].archivo);
}

// ═══════════════════════════════════════════════════════════════
//  IDENTIDAD DEL NEGOCIO
// ═══════════════════════════════════════════════════════════════
let MARCA = { nombre: 'D´Padrones', lema: '', logo: null };

// Los datos de contacto del negocio, y en qué casilla de Ajustes se escribe
// cada uno. En una sola lista para que añadir un campo sea tocar aquí y el
// HTML, y no cuatro sitios que se olvidan de uno. Salen en el pie de los PDF.
const CAMPOS_MARCA = {
  direccion: 'mk-direccion', telefono: 'mk-telefono', correo: 'mk-correo'
};

// Se pide SIN sesión, porque la pantalla de entrar necesita el logo y el
// nombre antes de que nadie haya entrado.
// EL NOMBRE Y EL LOGO SE PINTAN DE MEMORIA (DECISIONES.md #45). Son lo primero
// que se ve, no cambian casi nunca, y esperar a que el servidor los mande dejaba
// la pantalla de entrar en blanco todo un viaje de ida y vuelta —que por el
// internet de un teléfono es medio segundo largo, y a veces mucho más—.
//
// Se guardan en el dispositivo la primera vez y a partir de ahí se pintan al
// instante; el servidor se pregunta igual, pero POR DETRÁS y sin que nadie
// espere. Si contesta algo distinto, se repinta.
function marcaGuardada() {
  try {
    const t = localStorage.getItem('dp_marca');
    if (t) MARCA = Object.assign(MARCA, JSON.parse(t));
  } catch (e) { /* si está rota, se pinta la de fábrica y se pide de nuevo */ }
  pintarMarca();
}

async function cargarMarca() {
  try {
    MARCA = Object.assign(MARCA, await api('/api/marca'));
    try { localStorage.setItem('dp_marca', JSON.stringify(MARCA)); } catch (e) {}
  } catch (e) {}
  pintarMarca();
}

function pintarMarca() {
  document.title = MARCA.nombre;
  document.querySelectorAll('.marca, header .nom').forEach(e => { e.textContent = MARCA.nombre; });
  document.querySelectorAll('.lemaGrande').forEach(e => { e.textContent = MARCA.lema; });
  const logo = MARCA.logo || 'img/logo.png';
  document.querySelectorAll('header img, .logoGrande').forEach(e => { e.src = logo; });
  if ($('mk-nombre') && !$('mk-nombre').value) $('mk-nombre').value = MARCA.nombre;
  if ($('mk-lema') && !$('mk-lema').value) $('mk-lema').value = MARCA.lema;
  // Los de contacto. Se rellenan igual: solo si están vacíos, para no pisar lo
  // que alguien esté escribiendo si esto se repinta por otra cosa.
  for (const k in CAMPOS_MARCA) {
    const el = $(CAMPOS_MARCA[k]);
    if (el && !el.value && MARCA[k] !== undefined && MARCA[k] !== null) el.value = MARCA[k];
  }
  pintarLogoAjustes();
  // En la cabecera, el lema se sustituye por quién está dentro
  if (YO && $('quien')) $('quien').textContent = YO.persona.nombre + ' · ' + YO.cargo;
}

let logoNuevo;   // undefined = no se tocó; null = quitar; texto = cambiar
function pintarLogoAjustes() {
  const cont = $('mk-logo-prev');
  if (!cont) return;
  const l = logoNuevo === undefined ? MARCA.logo : logoNuevo;
  cont.innerHTML = l ? '<img src="' + l + '" alt="">' : '<span>Sin logo</span>';
  $('mk-logo-quitar').style.display = l ? 'inline-flex' : 'none';
}
function elegirLogo(ev) {
  const f = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  encogerFoto(f, datos => { logoNuevo = datos; pintarLogoAjustes(); });
}
function quitarLogo() { logoNuevo = null; pintarLogoAjustes(); }

async function guardarMarca() {
  const cuerpo = { nombre: $('mk-nombre').value.trim() || 'D´Padrones',
                   lema: $('mk-lema').value.trim() };
  for (const k in CAMPOS_MARCA) {
    const el = $(CAMPOS_MARCA[k]);
    if (el) cuerpo[k] = el.value.trim();
  }
  if (logoNuevo !== undefined) cuerpo.logo = logoNuevo;
  try {
    const r = await api('/api/marca', { method: 'POST', body: JSON.stringify(cuerpo) });
    MARCA = Object.assign({}, r);
    delete MARCA.ok;
    logoNuevo = undefined;
    pintarMarca();
    toast('✓ Guardado');
  } catch (e) { alert('No se pudo guardar: ' + e.message); }
}

// ═══════════════════════════════════════════════════════════════
//  RECUPERAR EL PIN
// ═══════════════════════════════════════════════════════════════
// No hay correo ni mensajes que mandar, así que la recuperación es una clave
// que se entrega al crear el administrador. A los trabajadores les cambia el
// PIN el administrador, que es la jerarquía correcta: alguien que está ahí y
// puede reconocer a la persona.
function verOlvide() {
  $('form-entrar').style.display = 'none';
  $('form-clave').style.display = 'none';
  $('form-olvide').style.display = 'block';
  $('ol-usuario').value = $('in-usuario').value;
  $('ol-error').textContent = '';
}
function verEntrar() {
  $('form-olvide').style.display = 'none';
  $('form-clave').style.display = 'none';
  $('form-admin').style.display = 'none';
  $('form-entrar').style.display = 'block';
}
function verClave(clave) {
  $('clave-valor').textContent = clave;
  $('form-entrar').style.display = 'none';
  $('form-admin').style.display = 'none';
  $('form-olvide').style.display = 'none';
  $('form-clave').style.display = 'block';
}
function copiarClave() {
  const t = $('clave-valor').textContent;
  if (navigator.clipboard) navigator.clipboard.writeText(t).then(
    () => toast('✓ Copiada'), () => toast('Apúntala a mano: ' + t));
  else toast('Apúntala a mano: ' + t);
}

async function recuperarPin() {
  const usuario = $('ol-usuario').value.trim();
  const clave = $('ol-clave').value.trim();
  const pin = $('ol-pin').value;
  if (!usuario || !clave || pin.length < 4) {
    $('ol-error').textContent = 'Rellena los tres campos; el PIN necesita 4 números o más.';
    return;
  }
  try {
    const r = await api('/api/auth/recuperar', { method: 'POST',
      body: JSON.stringify({ usuario, clave, pin }) });
    $('in-usuario').value = usuario;
    alert('PIN cambiado.\n\nTu clave de recuperación nueva es:\n\n' + r.clave_nueva +
          '\n\nApúntala: la anterior ya no sirve.');
    verClave(r.clave_nueva);
  } catch (e) { $('ol-error').textContent = e.message; }
}

// Cambiarse el PIN uno mismo. Las tres casillas se limpian siempre al acabar,
// salga bien o mal: en un teléfono compartido, un PIN escrito y visible en una
// casilla es el PIN a la vista del siguiente que lo coja.
async function cambiarMiPin() {
  const actual = $('mp-actual').value, nuevo = $('mp-nuevo').value, repe = $('mp-repe').value;
  const limpiar = () => { $('mp-actual').value = ''; $('mp-nuevo').value = ''; $('mp-repe').value = ''; };
  if (!actual || !nuevo) { toast('⚠ Escribe el PIN de ahora y el nuevo'); return; }
  // Comprobado aquí antes de mandarlo: el servidor no puede saber si te has
  // equivocado al repetirlo, solo le llega uno de los dos.
  if (nuevo !== repe) { toast('⚠ El PIN nuevo y su repetición no son iguales'); $('mp-repe').focus(); return; }
  if (!/^\d{4,}$/.test(nuevo)) { toast('⚠ El PIN es solo números, y al menos 4'); return; }
  try {
    const r = await api('/api/auth/mi-pin', { method: 'POST', body: JSON.stringify({
      pin_actual: actual, pin_nuevo: nuevo }) });
    limpiar();
    alert('✓ PIN cambiado.\n\nA partir de ahora entras con el nuevo.' +
      (r.sesiones_cerradas ? '\n\nSe cerró tu sesión en ' + r.sesiones_cerradas +
        ' otro(s) dispositivo(s): allí hay que volver a entrar.' : ''));
  } catch (e) { limpiar(); alert('No se pudo cambiar: ' + e.message); }
}

async function generarClave() {
  if (!confirm('Se genera una clave nueva y la anterior deja de servir.\n\n¿Seguir?')) return;
  try {
    const r = await api('/api/auth/nueva-clave', { method: 'POST' });
    $('mk-clave').innerHTML = '<div class="codigoGrande" style="font-size:21px">' +
      esc(r.clave) + '</div><div class="pista">Apúntala y guárdala fuera del teléfono. ' +
      'No se vuelve a mostrar.</div>';
  } catch (e) { alert('No se pudo: ' + e.message); }
}

// ═══════════════════════════════════════════════════════════════
//  ENTRAR: personas, cargos y permisos
// ═══════════════════════════════════════════════════════════════

let CARGOS = [], PERSONAS = [];
let cargoEditando = null, personaEditando = null;

// ARRANCAR SIN HACER COLA. Esto eran cinco viajes al servidor uno detrás de otro
// —marca, estado, yo, y luego el resto—, y cada uno esperando a que contestara el
// anterior. Por el internet de un teléfono eso es la diferencia entre abrir la
// aplicación y esperar mirándola.
//
// Ahora la marca se pinta de memoria, y los dos que hacen falta salen A LA VEZ:
// no dependen uno del otro. El de «estado» solo importa para dos cosas —saber si
// todavía no hay administrador y traer el catálogo de permisos—, así que su
// respuesta se recoge cuando llegue y nadie la espera para entrar.
async function arrancar() {
  marcaGuardada();
  const rec = localStorage.getItem('dp_usuario');
  if (rec) { $('in-usuario').value = rec; $('in-recordar').checked = true; }

  const marca = cargarMarca();
  const estado = api('/api/auth/estado').then(e => {
    PERMISOS_POSIBLES = e.permisos_posibles || [];
    return e;
  }).catch(err => { $('in-error').textContent = err.message; return null; });

  // Con sesión guardada se va derecho a entrar, sin esperar a «estado»: quien ya
  // entró alguna vez en este dispositivo no necesita que le pregunten si hay
  // administrador.
  if (token()) {
    try {
      YO = await api('/api/auth/yo');
      return entrarEnLaApp();
    } catch (e) { localStorage.removeItem('dp_token'); }
  }

  // Sin sesión, aquí sí hace falta saberlo: la primera vez de todas, en vez de
  // pedir usuario y PIN, se crea el administrador.
  const e = await estado;
  await marca;
  if (e && !e.hay_admin) {
    $('form-entrar').style.display = 'none';
    $('form-admin').style.display = 'block';
  }
  document.body.classList.add('entrando');
}

async function crearAdmin() {
  const nombre = $('ad-nombre').value.trim();
  const usuario = $('ad-usuario').value.trim();
  const pin = $('ad-pin').value;
  if (!nombre || !usuario || pin.length < 4) {
    $('ad-error').textContent = 'Rellena los tres campos; el PIN necesita 4 números o más.';
    return;
  }
  try {
    const r = await api('/api/auth/crear-admin', { method: 'POST',
      body: JSON.stringify({ nombre, usuario, pin }) });
    $('in-usuario').value = usuario;
    localStorage.setItem('dp_usuario', usuario);
    verClave(r.clave);
  } catch (e) { $('ad-error').textContent = e.message; }
}

async function entrar() {
  const usuario = $('in-usuario').value.trim();
  const pin = $('in-pin').value;
  if (!usuario || !pin) { $('in-error').textContent = 'Pon tu usuario y tu PIN.'; return; }
  try {
    const r = await api('/api/auth/entrar', { method: 'POST',
      // 'aparato' es el nombre de la COLUMNA en la tabla de sesiones. Lo que se
      // ve en pantalla se dice «dispositivo», pero renombrar lo que se habla con
      // el servidor obligaría a migrar la tabla para no ganar nada.
      body: JSON.stringify({ usuario, pin, aparato: navigator.userAgent.slice(0, 60) }) });
    localStorage.setItem('dp_token', r.token);
    if ($('in-recordar').checked) localStorage.setItem('dp_usuario', usuario);
    else localStorage.removeItem('dp_usuario');
    YO = { persona: r.persona, cargo: r.cargo, permisos: r.permisos,
           mis_sitios: r.mis_sitios };
    $('in-pin').value = '';
    $('in-error').textContent = '';
    entrarEnLaApp();
  } catch (e) { $('in-error').textContent = e.message; }
}

function cerrarSesionLocal() {
  localStorage.removeItem('dp_token');
  YO = null;
  document.body.classList.add('entrando');
  $('form-entrar').style.display = 'block';
}

async function salir() {
  if (!confirm('¿Salir de la aplicación?')) return;
  try { await api('/api/auth/salir', { method: 'POST' }); } catch (e) {}
  cerrarSesionLocal();
}

// ─── Ajustes por secciones ────────────────────────────────────
// Eran quince tarjetas seguidas y el dueño se perdía. Ahora se entra por un
// índice y solo se ve el apartado que hace falta.
function abrirAjustes(sec) {
  $('aj-indice').style.display = 'none';
  document.querySelectorAll('.ajSec').forEach(s => {
    s.style.display = s.id === 'aj-' + sec ? 'block' : 'none';
  });
  window.scrollTo(0, 0);
}
function volverAjustes() {
  $('aj-indice').style.display = 'block';
  document.querySelectorAll('.ajSec').forEach(s => { s.style.display = 'none'; });
  window.scrollTo(0, 0);
}

// Un apartado del que este cargo no pueda ver ni una tarjeta no sale en el
// índice. Se mira lo que ha quedado visible en vez de repetir los permisos en
// el botón: así, al añadir mañana una tarjeta nueva, esto sigue acertando solo.
function ajustesSegunPermisos() {
  document.querySelectorAll('#aj-indice .ajIndice').forEach(b => {
    const sec = $('aj-' + b.dataset.sec);
    if (!sec) return;
    const hay = [...sec.querySelectorAll('.tarjeta')]
      .some(t => t.style.display !== 'none' && !t.hasAttribute('hidden'));
    b.style.display = hay ? '' : 'none';
  });
}

// Esconde lo que este cargo no puede hacer. Cada elemento con data-permiso
// desaparece si falta el permiso; el servidor lo rechazaría igual.
function aplicarPermisos() {
  document.querySelectorAll('[data-permiso]').forEach(el => {
    el.style.display = puedo(...el.dataset.permiso.split(',')) ? '' : 'none';
  });
  ajustesSegunPermisos();
  // Se vuelve a donde estabas, si ese cargo todavía puede entrar ahí. La
  // pantalla ya está puesta desde el arranque; esto solo la corrige si el cargo
  // no tiene permiso, y dispara la carga de sus datos.
  const guardada = localStorage.getItem('dp_pantalla');
  const permitida = p => {
    const b = document.querySelector('nav button[data-p="' + p + '"]');
    return b && b.style.display !== 'none';
  };
  const primera = (guardada && permitida(guardada)) ? guardada
    : (puedo('vender') ? 'caja' : (puedo('gestionar_inventario', 'traslados_enviar', 'traslados_recibir', 'ver_catalogo') ? 'almacen' : 'ajustes'));
  const btn = document.querySelector('nav button[data-p="' + primera + '"]');
  if (btn) irA(primera, btn);
}

async function entrarEnLaApp() {
  document.body.classList.remove('entrando');
  $('quien').textContent = YO.persona.nombre + ' · ' + YO.cargo;
  pintarTiraComo();
  // Si le asignaron un sitio, ese es el suyo mientras no elija otro. Estando en la
  // piel de otro manda el sitio de ESE, y se pisa el guardado: si no, se estaría
  // mirando la tienda de uno con los permisos del otro, que no es lo que nadie ve
  // en la realidad, y el servidor rechazaría cada petición por sitio ajeno (#35).
  if (YO.como && YO.como.sitio_id) localStorage.setItem('dp_sitio', YO.como.sitio_id);
  else if (YO.persona.sitio_id && !localStorage.getItem('dp_sitio'))
    localStorage.setItem('dp_sitio', YO.persona.sitio_id);
  SITIO = localStorage.getItem('dp_sitio') || '';
  // TODO LO QUE NO DEPENDE DE NADA, A LA VEZ. Esto era una fila de viajes al
  // servidor esperando cada uno al anterior —tasa, billetes, catálogo, existencias,
  // clientes, avisos—, y por el internet de un teléfono cada viaje es medio segundo
  // largo. En fila son seis; a la vez es uno.
  //
  // El catálogo es el único que espera a la tasa, y por un motivo: necesita saber
  // en qué moneda se mide el negocio para pintar los precios. Lo demás no espera a
  // nadie, y los avisos y los clientes ni siquiera se esperan aquí: llegan cuando
  // lleguen y se repintan solos.
  const conTasa = Promise.all([cargarTasa(), cargarDenominaciones()])
    .then(() => {
      if ($('caja-moneda')) $('caja-moneda').value = MONEDA;
      return cargarCatalogo();
    });
  const existencias = cargarStock();
  cargarClientes();          // solo hace falta al cobrar; no se espera
  cargarAvisos();            // la campanita se pinta sola cuando conteste
  recuperarCarro();
  await Promise.all([conTasa, existencias]);
  renderCarro();
  aplicarPermisos();
  // Se vuelve a mirar cada pocos minutos, y solo con la pantalla encendida: un
  // teléfono guardado en el bolsillo no tiene por qué estar preguntando.
  setInterval(() => { if (!document.hidden) cargarAvisos(); }, CADA_AVISOS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) cargarAvisos(); });
}

// ─── Cargos ───────────────────────────────────────────────────
async function cargarPersonal() {
  if (!puedo('gestionar_personas')) return;
  try {
    const d = await api('/api/cargos');
    CARGOS = d.cargos || [];
    PERSONAS = d.personas || [];
    PERMISOS_POSIBLES = d.permisos_posibles || PERMISOS_POSIBLES;
  } catch (e) { return; }

  $('lista-cargos').innerHTML = CARGOS.map(c => {
    const lista = c.es_admin ? '<span class="chip admin">Todo</span>'
      : (c.permisos ? c.permisos.split(',').map(p => {
          const d = PERMISOS_POSIBLES.find(x => x.id === p);
          return '<span class="chip">' + esc(d ? d.nombre : p) + '</span>';
        }).join('') : '<span class="chip">Sin permisos</span>');
    // Dónde vale, que es tan importante como qué puede: un cargo con todos los
    // permisos en «su local» y otro con los mismos en «todos» son cosas muy
    // distintas, y en la lista se veían iguales.
    const donde = c.es_admin ? 'en todo el negocio'
      : (c.alcance === 'todos') ? 'en todos los locales'
      : (c.alcance === 'lista')
        ? 'en ' + (String(c.sitios || '').split(',').filter(Boolean)
            .map(id => (SITIOS.find(s => s.id === id) || {}).nombre || '?').join(' y ')
            || 'ningún local todavía')
      : 'en el local de cada persona';
    return `<div class="venta" ${c.es_admin ? '' : `onclick="abrirCargo('${c.id}')" style="cursor:pointer"`}>
      <div class="cab"><span style="font-weight:700;font-size:14px">${esc(c.nombre)}</span>
        ${c.es_admin ? '<span class="hora">no se puede editar</span>' : '<span class="hora">tocar para editar</span>'}</div>
      <div class="hora" style="margin-top:2px">${esc(donde)}</div>
      <div style="margin-top:5px">${lista}</div>
    </div>`;
  }).join('');

  // En qué moneda se le paga sale AQUÍ, en la lista. Estaba solo dentro de la
  // ficha, y para verla había que saber que la fila se toca: el dueño la buscó y
  // no la encontró, y dio por hecho que no se había hecho. Un dato que hay que
  // adivinar cómo abrir es un dato que no existe.
  $('lista-personas').innerHTML = PERSONAS.length ? PERSONAS.map(p => `
    <div class="fila" onclick="abrirPersona('${p.id}')" style="cursor:pointer">
      <span>${esc(p.nombre)}${p.activo ? '' : ' <span style="color:var(--rojo);font-size:11px">(sin acceso)</span>'}
        <br><span style="font-size:11.5px;color:var(--texto3)">${esc(p.usuario)} · ${esc(p.cargo || 'sin cargo')}${
          p.sitio ? ' · ' + esc(p.sitio) : ''}<br>se le paga en <b>${
          p.moneda_pago === 'USD' ? 'USD — dólares' : p.moneda_pago === 'CUP' ? 'CUP — pesos'
            : MONEDA_BASE + ' (la moneda del negocio)'}</b></span></span>
      <span style="text-align:right;white-space:nowrap;color:var(--texto3)">tocar para cambiar ›${
        // Meterse en su piel para ir viendo qué le falta. Solo el administrador, y
        // solo hacia quien no lo es: el servidor lo vuelve a comprobar.
        puedo('*') && p.activo && p.id !== (YO && YO.persona && YO.persona.id)
          ? '<br><button class="acc" onclick="event.stopPropagation();verComo(\'' + p.id +
            '\')">ver la app como ' + esc((p.nombre || '').split(' ')[0]) + '</button>' : ''}
      </span>
    </div>`).join('') : '<div class="vacio">Solo estás tú.</div>';
}

function abrirCargo(id) {
  cargoEditando = id || null;
  const c = id ? CARGOS.find(x => x.id === id) : null;
  const tiene = c ? String(c.permisos || '').split(',') : [];
  $('cg-titulo').textContent = c ? 'Editar cargo' : 'Nuevo cargo';
  $('cg-nombre').value = c ? c.nombre : '';
  // Dónde valen los permisos de este cargo.
  $('cg-alcance').value = (c && c.alcance) || 'propio';
  const marcados = String((c && c.sitios) || '').split(',').map(s => s.trim()).filter(Boolean);
  $('cg-sitios').innerHTML = SITIOS.map(s => `
    <label class="permiso"><input type="checkbox" value="${s.id}"${
      marcados.includes(s.id) ? ' checked' : ''}> ${esc(s.nombre)}</label>`).join('');
  alElegirAlcance();
  // Por ÁREAS, con un «todo» por área. Son más de cuarenta permisos desde que se
  // partieron los quince viejos (uno solo abría media aplicación), y cuarenta
  // casillas seguidas en un teléfono no se leen: se marcan a ciegas, que es peor
  // que no tener permisos.
  const areas = [];
  for (const p of PERMISOS_POSIBLES) {
    const nombre = p.area || 'Otros';
    let a = areas.find(x => x.nombre === nombre);
    if (!a) { a = { nombre, lista: [] }; areas.push(a); }
    a.lista.push(p);
  }
  $('cg-permisos').innerHTML = areas.map(a => `
    <div class="tarjeta" style="margin-top:10px;padding:11px 12px">
      <div class="fila" style="border:0;padding:0 0 6px">
        <b style="font-size:12.5px;text-transform:uppercase;color:var(--texto3)">${esc(a.nombre)}</b>
        <button class="acc" onclick="marcarArea('${esc(a.nombre)}',true)">todo</button>
      </div>
      ${a.lista.map(p => `<label class="permiso" data-area="${esc(a.nombre)}">
        <input type="checkbox" value="${p.id}"${tiene.includes(p.id) ? ' checked' : ''}
               onchange="alTocarPermiso(this)">
        ${esc(p.nombre)}</label>`).join('')}
    </div>`).join('');
  // Quitar solo tiene sentido en uno que ya existe, y nunca en el de
  // administrador. Que no lo tenga nadie puesto lo comprueba el servidor.
  $('cg-borrar').style.display = (c && !c.es_admin) ? 'block' : 'none';
  $('velo-cargo').classList.add('abierto');
}
function cerrarCargo() { $('velo-cargo').classList.remove('abierto'); }

// Explica en palabras qué significa cada alcance, porque es la diferencia entre un
// cargo que sirve para las tres tiendas y uno que abre las tres a todo el mundo.
function alElegirAlcance() {
  const v = $('cg-alcance').value;
  $('cg-sitios-caja').style.display = v === 'lista' ? 'block' : 'none';
  $('cg-alcance-pista').innerHTML =
    v === 'propio' ? 'Cada persona con este cargo solo podrá tocar <b>el local que tenga ' +
      'puesto en su ficha</b>. Así un mismo cargo «Vendedor» sirve para todas las tiendas.'
    : v === 'lista' ? 'Vale en <b>los locales que marques abajo</b>, y en ninguno más. Lo tendrán ' +
      'igual todas las personas con este cargo, sea cual sea su local.'
    : 'Sin límite: quien tenga este cargo podrá tocar <b>cualquier local</b> del negocio.';
}

// Quitar un permiso que otro NECESITA no se puede, y hay que decirlo. El servidor
// vuelve a encender lo que hace falta para que lo marcado funcione —no se puede
// vender sin ver el catálogo, ni corregir un costo sin ver los costos—, y hasta hoy
// lo hacía en silencio: se desmarcaba, se guardaba, y el permiso seguía ahí sin que
// nadie explicara por qué. Parecía que la aplicación no guardaba.
//
// Ahora se avisa EN EL MOMENTO de desmarcarlo y se dice cuál hay que quitar primero.
function alTocarPermiso(casilla) {
  if (casilla.checked) return;                    // marcar nunca sobra
  const marcados = [...document.querySelectorAll('#cg-permisos input:checked')]
    .map(i => i.value);
  // Quién de los que siguen marcados necesita al que se acaba de quitar. Se mira en
  // cadena: un permiso puede necesitarlo a través de un tercero.
  const necesitanEste = marcados.filter(id => {
    const dentro = new Set([id]);
    let creciendo = true;
    while (creciendo) {
      creciendo = false;
      for (const p of PERMISOS_POSIBLES)
        if (dentro.has(p.id)) for (const i of (p.implica || []))
          if (!dentro.has(i)) { dentro.add(i); creciendo = true; }
    }
    return dentro.has(casilla.value);
  });
  if (!necesitanEste.length) return;
  const nombreDe = id => (PERMISOS_POSIBLES.find(p => p.id === id) || {}).nombre || id;
  casilla.checked = true;                         // se vuelve a marcar: sin él no valdría
  alert('«' + nombreDe(casilla.value) + '» no se puede quitar mientras esté marcado:\n\n' +
    necesitanEste.map(id => '· ' + nombreDe(id)).join('\n') +
    '\n\nEso no funcionaría sin este permiso. Quita primero el de arriba y luego este.');
}

// Marcar (o desmarcar) todo un área de una vez. El botón dice «todo» y pasa a
// «ninguno» cuando ya está todo marcado: es el mismo gesto para las dos cosas.
function marcarArea(area) {
  const casillas = [...document.querySelectorAll(
    '#cg-permisos label[data-area="' + area.replace(/"/g, '') + '"] input')];
  const todas = casillas.every(c => c.checked);
  casillas.forEach(c => { c.checked = !todas; });
}

// ─── VER LA APLICACIÓN COMO OTRO (DECISIONES.md #35) ──────────
// El administrador se mete en la piel de un trabajador para ir armándole los
// permisos con la pantalla delante. Lo que apunte queda a SU nombre: la tira de
// arriba está para no olvidarlo.
async function verComo(personaId) {
  const p = PERSONAS.find(x => x.id === personaId);
  if (p && !confirm('Vas a ver la aplicación como ' + p.nombre + '.\n\n' +
      'Verás y podrás hacer exactamente lo que puede hacer ' + p.nombre +
      '. Lo que apuntes es REAL y queda a tu nombre, con la nota de que actuabas ' +
      'como ' + p.nombre + '.\n\n¿Seguimos?')) return;
  try {
    await api('/api/auth/como', { method: 'POST', body: JSON.stringify({ persona_id: personaId }) });
    // Se recarga entera: los menús, los botones y las pantallas se pintan al
    // arrancar según los permisos, y repintar media aplicación a mano dejaría
    // trozos con los permisos de antes.
    location.reload();
  } catch (e) { alert('No se pudo: ' + e.message); }
}

async function dejarDeVerComo() {
  try {
    await api('/api/auth/como', { method: 'POST', body: JSON.stringify({}) });
    // Se olvida el sitio: al entrar en la piel del otro se pisó con el suyo, y
    // volver quedándose en la tienda de otro es confuso y además puede dejar la
    // pantalla mirando un sitio que ya no toca.
    localStorage.removeItem('dp_sitio');
    location.reload();
  } catch (e) { alert('No se pudo salir: ' + e.message); }
}

// La tira de arriba. Sin ella se olvida en dos minutos que se está dentro de otra
// piel, y se acaba apuntando cosas creyendo ser uno mismo.
function pintarTiraComo() {
  const caja = $('tira-como');
  if (!caja) return;
  if (!YO || !YO.como) { caja.style.display = 'none'; document.body.classList.remove('encomo'); return; }
  caja.style.display = 'block';
  document.body.classList.add('encomo');
  caja.innerHTML = '<b>Estás viendo la aplicación como ' + esc(YO.como.nombre) + '</b>' +
    '<span> · ' + esc(YO.como.cargo || 'sin cargo') + '</span>' +
    '<button class="btn" onclick="dejarDeVerComo()">Volver a ser yo</button>' +
    (FALTAN.length ? '<div class="faltan"><b>Le falta permiso para:</b>' +
      FALTAN.map(f => '<span>' + esc(f.nombre) +
        ' <button class="acc" onclick="darPermiso(\'' + f.id + '\')">dárselo</button></span>'
      ).join('') + '</div>' : '');
}

// Cuando una puerta se cierra, se apunta QUÉ permiso faltó y se ofrece dárselo al
// cargo. Es la pieza que hace útil todo lo demás: el dueño dijo que no tiene claro
// qué debe poder hacer cada trabajador y que quiere ir dándoselo sobre la marcha,
// no de memoria en una lista de cuarenta casillas.
//
// Se APUNTA y se enseña en la tira de arriba, en vez de saltar una ventana en el
// momento. Entrar en una pantalla dispara varias peticiones a la vez: con una
// ventana por cada una, moverse por la aplicación sería contestar preguntas.
let FALTAN = [];      // [{id, nombre, cargo_id}]

function registrarFalta(datos) {
  if (!datos || !datos.falta || !datos.falta.length || !datos.de_cargo) return;
  if (!YO || !YO.como) return;                 // solo tiene sentido dentro de otra piel
  for (const f of datos.falta)
    if (!FALTAN.some(x => x.id === f.id))
      FALTAN.push({ id: f.id, nombre: f.nombre, cargo_id: datos.de_cargo });
  pintarTiraComo();
}

async function darPermiso(id) {
  const f = FALTAN.find(x => x.id === id);
  if (!f) return;
  try {
    const r = await api('/api/cargos/' + f.cargo_id + '/permiso', { method: 'POST',
      body: JSON.stringify({ permiso: f.id }) });
    // Se dice a cuánta gente afecta: dárselo a un CARGO no es dárselo a una
    // persona, y eso sorprende si nadie lo avisa.
    alert('✓ «' + f.nombre + '» dado al cargo «' + r.cargo + '».\n\n' +
      'Lo tienen ahora ' + r.personas + ' persona(s).');
    location.reload();
  } catch (e) { alert('No se pudo dar el permiso: ' + e.message); }
}

async function guardarCargo() {
  const nombre = $('cg-nombre').value.trim();
  if (!nombre) { toast('⚠ Ponle nombre al cargo'); return; }
  const permisos = [...document.querySelectorAll('#cg-permisos input:checked')].map(i => i.value);
  try {
    const r = await api('/api/cargos', { method: 'POST', body: JSON.stringify({
      id: cargoEditando || undefined, nombre, permisos,
      alcance: $('cg-alcance').value,
      sitios: [...document.querySelectorAll('#cg-sitios input:checked')].map(i => i.value) }) });
    cerrarCargo();
    // Lo que quedó guardado puede no ser lo que se marcó: hay permisos que se
    // encienden solos porque otro los necesita. Se dice cuáles, o quien desmarcó uno
    // se queda pensando que la aplicación no guarda.
    const extra = (r.permisos || []).filter(p => !permisos.includes(p));
    if (extra.length) {
      const nombreDe = id => (PERMISOS_POSIBLES.find(x => x.id === id) || {}).nombre || id;
      alert('✓ Cargo guardado.\n\nSe han dejado puestos estos, porque otros permisos ' +
        'que marcaste no funcionan sin ellos:\n\n' + extra.map(p => '· ' + nombreDe(p)).join('\n'));
    } else toast('✓ Cargo guardado');
    await cargarPersonal();
  } catch (e) { alert('No se pudo guardar: ' + e.message); }
}

// Quitar un cargo que se creó probando. El servidor se niega si lo tiene
// alguien puesto y dice quién: sin ese aviso habría que ir a mirar la lista de
// trabajadores uno por uno para adivinar por qué no deja.
async function eliminarCargo() {
  const c = CARGOS.find(x => x.id === cargoEditando);
  if (!c) return;
  if (!confirm('¿Quitar el cargo «' + c.nombre + '»?\n\n' +
      'Deja de salir en la lista y no se le podrá poner a nadie. Los apuntes ' +
      'que hizo el personal que lo tuvo no se tocan.')) return;
  try {
    await api('/api/cargos/' + c.id, { method: 'DELETE' });
    cerrarCargo();
    toast('✓ Cargo quitado');
    await cargarPersonal();
  } catch (e) { alert('No se pudo quitar: ' + e.message); }
}

// ─── Trabajadores ─────────────────────────────────────────────
function abrirPersona(id) {
  personaEditando = id || null;
  const p = id ? PERSONAS.find(x => x.id === id) : null;
  $('pe-titulo').textContent = p ? 'Editar trabajador' : 'Nuevo trabajador';
  $('pe-nombre').value = p ? p.nombre : '';
  $('pe-usuario').value = p ? p.usuario : '';
  $('pe-pin').value = '';
  $('pe-pin-lbl').textContent = p ? 'PIN nuevo (dejar vacío para no cambiarlo)' : 'PIN *';
  $('pe-cargo').innerHTML = CARGOS.map(c =>
    `<option value="${c.id}"${p && p.cargo_id === c.id ? ' selected' : ''}>${esc(c.nombre)}</option>`).join('');
  $('pe-sitio').innerHTML = '<option value="">Cualquiera</option>' + SITIOS.map(s =>
    `<option value="${s.id}"${p && p.sitio_id === s.id ? ' selected' : ''}>${esc(s.nombre)}</option>`).join('');
  $('pe-moneda-pago').value = (p && p.moneda_pago) || '';
  $('pe-activo-caja').style.display = p ? 'block' : 'none';
  $('pe-activo').checked = p ? !!p.activo : true;
  // Quitar solo tiene sentido sobre alguien que ya existe, y nunca sobre uno
  // mismo: el servidor lo niega igual, pero ofrecer un botón que va a decir que
  // no es hacer perder el tiempo.
  $('pe-borrar').style.display = (p && !esMiUsuario(p.id)) ? 'block' : 'none';
  $('velo-persona').classList.add('abierto');
  setTimeout(() => $('pe-nombre').focus(), 120);
}
function cerrarPersona() { $('velo-persona').classList.remove('abierto'); }

// Quién está usando la aplicación ahora mismo. Con la piel de otro puesta manda
// esa, que es de quién son los permisos que se están usando.
function esMiUsuario(id) {
  const yo = YO && (YO.como || YO.persona);
  return !!(yo && yo.id === id);
}

// QUITAR UN TRABAJADOR. No es lo mismo que quitarle el acceso: el acceso se le
// quita a quien se va unos meses y vuelve; esto es para quien ya no está, y lo
// saca de la lista, del reparto del día y de la puerta de entrada.
//
// Lo que hizo NO se toca: sus ventas, sus cierres y sus comisiones se quedan con
// su nombre. Se dice en el aviso, porque es justo lo que da miedo al pulsarlo.
async function eliminarPersona() {
  const p = PERSONAS.find(x => x.id === personaEditando);
  if (!p) return;
  if (!confirm('¿Quitar a ' + p.nombre + '?\n\n' +
      'Deja de salir en el personal y no podrá volver a entrar. Sus ventas, sus ' +
      'cierres y sus comisiones se quedan como están, con su nombre.\n\n' +
      'Si solo quieres que no entre por un tiempo, quita la marca de ' +
      '«Puede entrar en la aplicación» y guarda.')) return;
  try {
    await api('/api/personas/' + p.id, { method: 'DELETE' });
    cerrarPersona();
    toast('✓ Trabajador quitado');
    await cargarPersonal();
  } catch (e) { alert('No se pudo quitar: ' + e.message); }
}

async function guardarPersona() {
  const nombre = $('pe-nombre').value.trim();
  const usuario = $('pe-usuario').value.trim();
  const pin = $('pe-pin').value;
  if (!nombre || !usuario) { toast('⚠ Faltan el nombre o el usuario'); return; }
  if (!personaEditando && pin.length < 4) { toast('⚠ El PIN necesita 4 números o más'); return; }
  try {
    await api('/api/personas', { method: 'POST', body: JSON.stringify({
      id: personaEditando || undefined, nombre, usuario,
      pin: pin || undefined,
      cargo_id: $('pe-cargo').value || null,
      sitio_id: $('pe-sitio').value || null,
      moneda_pago: $('pe-moneda-pago').value || null,
      activo: personaEditando ? $('pe-activo').checked : true
    })});
    cerrarPersona();
    toast('✓ Guardado');
    await cargarPersonal();
  } catch (e) { alert('No se pudo guardar: ' + e.message); }
}

// ─── Comisiones ───────────────────────────────────────────────
// Tres cifras por persona y por mes: lo que le TOCA, lo que ya COBRÓ y lo que
// QUEDA. Las dos primeras salen de sitios distintos —la primera de las ventas,
// la segunda de los apuntes de dinero— y por eso la tercera vale para algo: es
// la única que dice si alguien está esperando su dinero.
let COMIS = null;

function mesComisiones() {
  if (!$('com-mes').value) $('com-mes').value = new Date().toLocaleDateString('sv-SE').slice(0, 7);
  return $('com-mes').value;
}

async function cargarComisiones() {
  if (!puedo('ver_comisiones')) return;
  const mes = mesComisiones();
  try {
    const d = await api('/api/comisiones?mes=' + mes);
    COMIS = d;
    $('lista-comisiones').innerHTML = d.comisiones.length ? d.comisiones.map(c => {
      // La comisión se MIDE en la moneda del negocio y se PAGA en la de cada uno.
      // Si son la misma no se repite el número dos veces.
      const otra = c.moneda_pago !== d.moneda_base && c.a_pagar !== null;
      const cobrado = c.pagado.CUP || c.pagado.USD;
      const pagos = [c.pagado.CUP ? dinero(c.pagado.CUP, 'CUP') : '',
                     c.pagado.USD ? dinero(c.pagado.USD, 'USD') : ''].filter(Boolean).join(' + ');
      return `<div class="fila" style="align-items:flex-start">
        <span>${esc(c.persona)}
        <br><span style="font-size:11.5px;color:var(--texto3)">${
          c.dias ? c.dias + ' día(s) trabajado(s) · ' : ''}${c.ventas} venta(s) · ${enBase(c.vendido)}${
          otra ? ' · le toca ' + enBase(c.comision) : ''}${
          c.de_reparto && c.propia ? '<br>de reparto ' + enBase(c.de_reparto) +
            ' · de sus ventas ' + enBase(c.propia) : ''}
        ${cobrado ? '<br>ya cobró <b>' + pagos + '</b>' +
            (c.queda === null ? ' <span style="color:var(--rojo)">(cobró en las dos monedas: ' +
              'lo que queda hay que verlo a mano)</span>'
             : c.queda > 0 ? ' · queda <b>' + dinero(c.queda, c.moneda_pago) + '</b>'
             : c.queda < 0 ? ' · <span style="color:var(--rojo)">cobró ' +
                 dinero(-c.queda, c.moneda_pago) + ' de más</span>'
             : ' · <span style="color:var(--marca-claro)">pagado del todo</span>') : ''}
        </span></span>
        <span style="text-align:right;white-space:nowrap">
          <b class="num" style="color:var(--acento-osc)">${
            otra ? dinero(c.a_pagar, c.moneda_pago) : enBase(c.comision)}</b>
          ${c.persona_id && puedo('pagar_comisiones') ? '<br><button class="acc" ' +
            `onclick="abrirPagoCom('${c.persona_id}')">Pagarle</button>` : ''}
        </span></div>`;
    }).join('') : '<div class="vacio">Sin ventas ese mes.</div>';

    // Dos avisos que no son de adorno: sin valor del dólar hay ventas que no
    // cuentan, y sin ningún día con lista el reparto no está entrando y las
    // comisiones siguen siendo de quien marcó la venta.
    $('com-aviso').innerHTML =
      (d.sin_tasa ? '<div class="pista">Falta el valor del dólar en Ajustes: alguna venta no ' +
        'se pudo pasar a ' + d.moneda_base + ' y no está contada.</div>' : '') +
      (d.comisiones.length && !d.dias_con_lista
        ? '<div class="pista">Ningún día de este mes tiene apuntado quién trabajó, así que la ' +
          'comisión es de quien marcó cada venta. Se apunta al cerrar la jornada.</div>' : '');
    await cargarPagosCom();
  } catch (e) { $('lista-comisiones').innerHTML = '<div class="vacio">' + e.message + '</div>'; }
}

// Los pagos ya hechos de ese mes, para poder deshacer una equivocación.
async function cargarPagosCom() {
  try {
    const d = await api('/api/comisiones/pagos?mes=' + mesComisiones());
    $('com-pagos').innerHTML = d.pagos.length
      ? '<label class="lbl">Pagos apuntados de este mes</label>' + d.pagos.map(p => `
        <div class="fila"><span>${esc(p.persona || '—')}
          <br><span style="font-size:11.5px;color:var(--texto3)">${esc(p.fecha)}${
            p.sitio ? ' · de la caja de ' + esc(p.sitio) : ' · de la empresa'}${
            p.anulado ? ' · <b style="color:var(--rojo)">anulado</b>' : ''}</span></span>
          <span style="text-align:right;white-space:nowrap">
            <b class="num">${dinero(p.importe, p.moneda)}</b>
            ${!p.anulado && puedo('pagar_comisiones') ? '<br><button class="acc" ' +
              `style="color:var(--rojo)" onclick="anularPagoCom('${p.id}')">Deshacer</button>` : ''}
          </span></div>`).join('')
      : '';
  } catch (e) { $('com-pagos').innerHTML = ''; }
}

let pagoComPersona = null;

function abrirPagoCom(personaId) {
  const c = (COMIS && COMIS.comisiones || []).find(x => x.persona_id === personaId);
  if (!c) return;
  pagoComPersona = personaId;
  $('pc-titulo').textContent = 'Pagar a ' + c.persona;
  $('pc-pista').innerHTML = 'Comisión de <b>' + esc(COMIS.mes) + '</b>. Le toca <b>' +
    (c.a_pagar === null ? enBase(c.comision) : dinero(c.a_pagar, c.moneda_pago)) + '</b>' +
    ((c.pagado.CUP || c.pagado.USD) ? ', y ya cobró ' +
      [c.pagado.CUP ? dinero(c.pagado.CUP, 'CUP') : '',
       c.pagado.USD ? dinero(c.pagado.USD, 'USD') : ''].filter(Boolean).join(' + ') : '') + '.';
  // Viene puesto lo que QUEDA, no lo que le toca: si ya cobró la mitad, lo que
  // se va a apuntar ahora es la otra mitad, y era donde se colaba pagar dos veces.
  $('pc-importe').value = c.queda !== null && c.queda > 0 ? c.queda
    : (c.a_pagar !== null ? c.a_pagar : '');
  $('pc-moneda').value = c.moneda_pago;
  $('pc-concepto').value = '';
  // Por defecto, la caja del sitio donde se está: es de donde sale el dinero de
  // la mano. El hueco vacío significa «de la empresa», como en los retiros.
  $('pc-sitio').innerHTML = '<option value="">De la empresa (sin sitio)</option>' +
    SITIOS.map(s => `<option value="${s.id}"${s.id === sitioActual() ? ' selected' : ''}>${
      esc(s.nombre)}</option>`).join('');
  $('velo-pagocom').classList.add('abierto');
}
function cerrarPagoCom() { $('velo-pagocom').classList.remove('abierto'); }

async function confirmarPagoCom() {
  const importe = parseFloat($('pc-importe').value);
  if (!(importe > 0)) { toast('⚠ Pon cuánto le vas a dar'); $('pc-importe').focus(); return; }
  try {
    await api('/api/comisiones/pagar', { method: 'POST', body: JSON.stringify({
      persona_id: pagoComPersona, mes: mesComisiones(), importe,
      moneda: $('pc-moneda').value, sitio_id: $('pc-sitio').value || null,
      concepto: $('pc-concepto').value.trim() || null }) });
    cerrarPagoCom();
    toast('✓ Pago apuntado');
    await cargarComisiones();
    // El dinero salió de una caja de verdad: si la pantalla del fondo está
    // cargada, hay que refrescarla o seguiría enseñando el saldo de antes.
    if (typeof cargarFondo === 'function' && puedo('ver_fondo')) {
      try { await cargarFondo(); } catch (e) {}
    }
  } catch (e) { alert('No se pudo apuntar: ' + e.message); }
}

async function anularPagoCom(id) {
  if (!confirm('¿Deshacer este pago?\n\nSe apunta el movimiento contrario y el dinero vuelve ' +
               'a la caja. Los dos apuntes quedan a la vista.')) return;
  try {
    await api('/api/comisiones/pago/' + id + '/anular', { method: 'POST' });
    toast('✓ Pago deshecho');
    await cargarComisiones();
    if (typeof cargarFondo === 'function' && puedo('ver_fondo')) {
      try { await cargarFondo(); } catch (e) {}
    }
  } catch (e) { alert('No se pudo deshacer: ' + e.message); }
}

// ═══════════════════════════════════════════════════════════════
//  SINCRONIZACIÓN
// ═══════════════════════════════════════════════════════════════

async function cargarSync() {
  if (!puedo('sincronizar')) return;
  pintarQueExportar();
  try {
    const d = await api('/api/sync/estado');
    $('sy-id').textContent = d.instalacion.slice(0, 8);
    $('sy-tengo').textContent = d.tengo.movimientos + ' movimientos · ' +
      d.tengo.ventas + ' ventas · ' + d.tengo.productos + ' productos';
    if (!$('sy-url').value) $('sy-url').value = d.servidor;
    if (!$('sy-usuario').value) $('sy-usuario').value = d.usuario;
    $('sy-historial').innerHTML = d.marcas.length
      ? '<div class="pista"><b>Últimas veces:</b><br>' + d.marcas.slice(0, 5).map(m =>
          esc(String(m.par).slice(0, 34)) + ' · ' +
          new Date(m.ultimo_uso).toLocaleString('es-CU') + ' · ' +
          (String(m.resultado || '').startsWith('error') ? '❌ ' + esc(m.resultado.slice(0, 60)) : '✓')
        ).join('<br>') + '</div>'
      : '';
  } catch (e) { /* sin permiso o sin servidor */ }
}

// ─── Por archivo ──────────────────────────────────────────────
// QUÉ SE PUEDE EXPORTAR: el negocio entero o un local suelto. La primera opción va
// la primera y es la que sale puesta, porque es la que contesta a «quiero una copia
// de todo»; la de un local suelto sirve para mandarle a un dispositivo solo lo suyo.
//
// Antes no había dónde elegir: se exportaba lo del sitio en el que se estuviera
// trabajando, y en Ajustes no se cambia de sitio, así que salía siempre lo del
// almacén principal y no había forma de sacar lo de una tienda ni lo de todos.
function pintarQueExportar() {
  const sel = $('sy-que');
  if (!sel) return;
  const antes = sel.value;
  sel.innerHTML = '<option value="">Todo el negocio — todos los almacenes y puntos</option>' +
    SITIOS.filter(s => s.activo !== 0)
      .map(s => `<option value="${s.id}">Solo ${esc(s.nombre)}</option>`).join('');
  sel.value = antes;
  if (sel.value !== antes) sel.value = '';
}

async function exportarPaquete() {
  try {
    const cual = $('sy-que') ? $('sy-que').value : '';
    // Sin sitio, el servidor manda el negocio entero. Se deja el parámetro fuera en
    // vez de mandarlo vacío para que se lea de un vistazo qué se está pidiendo.
    const p = await api('/api/sync/paquete' +
      (cual ? '?sitio_id=' + encodeURIComponent(cual) : ''));
    const limpio = String(p.sitio || 'sitio').toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-');
    const nombre = 'dpadrones-' + limpio + '-' + new Date().toLocaleDateString('sv-SE') + '.json';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(p)], { type: 'application/json' }));
    a.download = nombre;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('✓ Exportado ' + p.sitio);
  } catch (e) { alert('No se pudo exportar: ' + e.message); }
}

function importarPaquete(ev) {
  const f = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  const lector = new FileReader();
  lector.onload = async () => {
    let paquete;
    try { paquete = JSON.parse(lector.result); }
    catch (e) { return alert('Ese archivo no se puede leer.'); }
    if (!confirm('Vas a juntar los datos de ese archivo con los de aquí.\n\n' +
                 'No se borra ni se pisa nada: lo que ya esté se queda igual y solo se ' +
                 'añade lo que falte.\n\n¿Seguir?')) return;
    try {
      const r = await api('/api/sync/fusionar', { method: 'POST', body: JSON.stringify(paquete) });
      mostrarResultadoSync('Del archivo', r.aplicado);
      await cargarCatalogo();
      await cargarSync();
    } catch (e) { alert('No se pudo juntar: ' + e.message); }
  };
  lector.readAsText(f, 'UTF-8');
}

// ─── Por red ──────────────────────────────────────────────────
async function guardarServidorSync() {
  try {
    await api('/api/sync/servidor', { method: 'POST', body: JSON.stringify({
      url: $('sy-url').value, usuario: $('sy-usuario').value, pin: $('sy-pin').value }) });
    toast('✓ Guardado');
  } catch (e) { alert('No se pudo guardar: ' + e.message); }
}

async function sincronizarAhora() {
  const btn = $('btn-sync');
  btn.disabled = true;
  const antes = btn.textContent;
  btn.textContent = 'Sincronizando…';
  try {
    const r = await api('/api/sync/ahora', { method: 'POST', body: JSON.stringify({
      url: $('sy-url').value, usuario: $('sy-usuario').value, pin: $('sy-pin').value }) });
    mostrarResultadoSync('Enviado', r.subido, 'Recibido', r.bajado);
    await cargarCatalogo();
    await cargarSync();
    toast('✓ Sincronizado');
  } catch (e) {
    $('sy-resultado').innerHTML = '<div class="aviso"><b>No se pudo sincronizar.</b><br>' +
      esc(e.message) + '<br>Los datos de aquí no se han tocado: se puede volver a intentar ' +
      'cuando haya conexión.</div>';
  } finally { btn.disabled = false; btn.textContent = antes; }
}

function mostrarResultadoSync(t1, c1, t2, c2) {
  const linea = (t, c) => {
    const partes = Object.entries(c || {}).map(([k, v]) => v + ' ' + k);
    return '<b>' + t + ':</b> ' + (partes.length ? partes.join(', ') : 'nada nuevo');
  };
  $('sy-resultado').innerHTML = '<div class="aviso" style="background:rgba(31,169,113,.12);' +
    'border-color:rgba(31,169,113,.4)">' + linea(t1, c1) +
    (t2 ? '<br>' + linea(t2, c2) : '') + '</div>';
}

// ─── Sitios ───────────────────────────────────────────────────
function abrirSitio() {
  $('s-nombre').value = '';
  $('s-tipo').value = 'punto';
  $('s-padre').innerHTML = '<option value="">Independiente</option>' +
    SITIOS.filter(s => s.tipo === 'almacen')
      .map(s => `<option value="${s.id}">${esc(s.nombre)}</option>`).join('');
  const almacenes = SITIOS.filter(s => s.tipo === 'almacen');
  if (almacenes.length) $('s-padre').value = almacenes[0].id;
  $('velo-sitio').classList.add('abierto');
  setTimeout(() => $('s-nombre').focus(), 120);
}
function cerrarSitio() { $('velo-sitio').classList.remove('abierto'); }

async function guardarSitio() {
  const nombre = $('s-nombre').value.trim();
  if (!nombre) { toast('⚠ Ponle nombre'); return; }
  try {
    await api('/api/sitios', { method: 'POST', body: JSON.stringify({
      nombre, tipo: $('s-tipo').value, padre_id: $('s-padre').value || null }) });
    cerrarSitio();
    await cargarCatalogo();
    pintarSelectorSitio();
    cargarEstado();
    toast('✓ Creado');
  } catch (e) { alert('No se pudo crear: ' + e.message); }
}

// Lo que se escribió en la casilla del costo, pasado a LA MONEDA DEL NEGOCIO.
// El costo, el valor del almacén y la ganancia de cada venta se miden todos en
// esa moneda (DECISIONES.md #21), así que se convierte una vez al guardar.
//
// Esto convertía a pesos SIEMPRE, daba igual en qué se midiera el negocio.
// Puesta la medida en dólares —que es lo que quiere el dueño: aquí se compra en
// dólares y el peso se devalúa por debajo—, un costo de 300 dólares se guardaba
// como 36 000, el servidor lo leía como 36 000 dólares y la ganancia de cada
// venta de ese producto salía absurda. Reportado el 14 de agosto de 2026.
function costoEnBase(campo) {
  const n = parseFloat($(campo).value) || 0;
  const m = $('f-costo-moneda').value === 'USD' ? 'USD' : 'CUP';
  if (!n || m === MONEDA_BASE) return n;
  const c = convertir(n, m, MONEDA_BASE);
  return c === null ? n : redondearBase(c);
}
// La comisión fija del producto, pasada a la moneda del negocio. Mismo camino que
// el costo: se puede escribir en la moneda que se quiera y se guarda en una sola,
// porque a fin de mes hay que poder SUMAR lo que se le debe a una persona que ha
// vendido cosas con comisiones escritas en monedas distintas.
function comisionEnBase() {
  const n = parseFloat($('f-comision').value) || 0;
  const m = $('f-comision-moneda').value === 'USD' ? 'USD' : 'CUP';
  if (!n || m === MONEDA_BASE) return n;
  const c = convertir(n, m, MONEDA_BASE);
  return c === null ? n : redondearBase(c);
}

// Lo que se va a guardar de verdad, mientras se escribe. Y con el porcentaje, la
// casilla de moneda desaparece: un 5% no está en ninguna moneda.
function alCambiarComision() {
  const esPct = !!Number($('f-comision-tipo').value);
  $('f-comision-moneda-caja').style.display = esPct ? 'none' : '';
  const n = parseFloat($('f-comision').value) || 0;
  if (esPct) {
    const precio = parseFloat($('f-precio').value) || 0;
    const mp = $('f-precio-moneda').value === 'USD' ? 'USD' : 'CUP';
    $('f-comision-pista').innerHTML = !n || !precio
      ? 'Un porcentaje del precio de venta. Se calcula en cada venta, así que no ' +
        'hace falta decir en qué moneda está.'
      : 'De un precio de ' + dinero(precio, mp) + ', al vendedor le tocan <b>' +
        dinero(precio * n / 100, mp) + '</b> por unidad.';
    return;
  }
  const m = $('f-comision-moneda').value === 'USD' ? 'USD' : 'CUP';
  if (m === MONEDA_BASE) {
    $('f-comision-pista').innerHTML = 'Lo que se le da al vendedor por cada unidad. El ' +
      'negocio se mide en ' + (MONEDA_BASE === 'USD' ? 'dólares' : 'pesos') + ', así que se ' +
      'guarda tal cual. Si lo piensas en ' + (MONEDA_BASE === 'USD' ? 'pesos' : 'dólares') +
      ', cambia la casilla de arriba.<br><b>En qué moneda cobra cada trabajador</b> se elige ' +
      'aparte, en Ajustes → Personal → tocar su nombre → «Se le paga en».';
    return;
  }
  const c = convertir(n, m, MONEDA_BASE);
  $('f-comision-pista').innerHTML = c === null
    ? '<b>Falta poner el valor del dólar en Ajustes.</b> Sin él no se puede pasar esta ' +
      'comisión a ' + MONEDA_BASE + ', y se guardaría el número tal cual.'
    : !n ? 'Escríbela en ' + m + ' y se guardará en ' + MONEDA_BASE + '.'
    : 'Se guardará como <b>' + enBase(redondearBase(c)) + '</b> por unidad, al dólar de hoy.';
}

// La moneda dura lleva centavos; el peso, no. Guardar 36 000,47 pesos no
// significa nada y ensucia todas las cuentas de detrás.
const redondearBase = n => MONEDA_BASE === 'USD' ? Math.round(n * 100) / 100 : Math.round(n);

// Mientras se escribe, se enseña lo que se va a guardar de verdad. Sin esto,
// uno teclea 300 pensando en dólares y se guardan 300 pesos: el producto queda
// costando la centésima parte y nadie se entera hasta que las ganancias del mes
// salen absurdas.
function equivalenciaCosto() {
  const m = $('f-costo-moneda').value === 'USD' ? 'USD' : 'CUP';
  const n = parseFloat($('f-costo').value) || 0;
  const r = parseFloat($('f-costorepo').value) || 0;
  const nombre = MONEDA_BASE === 'USD' ? 'dólares' : 'pesos';
  const otro = MONEDA_BASE === 'USD' ? 'pesos' : 'dólares';
  if (m === MONEDA_BASE) {
    $('f-costo-equiv').textContent = 'El negocio se mide en ' + nombre + ', así que el costo ' +
      'se guarda tal cual. Si lo compraste en ' + otro + ', cambia la casilla de al lado y ' +
      'escribe esa cifra: la app hace la cuenta.';
    return;
  }
  const c = convertir(n, m, MONEDA_BASE);
  if (c === null) {
    $('f-costo-equiv').innerHTML = '<b>Falta poner el valor del dólar en Ajustes.</b> Sin él ' +
      'la app no puede pasar el costo a ' + nombre + ', y se guardaría el número tal cual.';
    return;
  }
  const rc = convertir(r, m, MONEDA_BASE);
  $('f-costo-equiv').innerHTML = !n ? 'Escríbelo en ' + otro + ' y se guardará en ' + nombre + '.'
    : 'Se guardará como <b>' + enBase(redondearBase(c)) + '</b>' +
      (r ? ' (y el de reposición, ' + enBase(redondearBase(rc)) + ')' : '') +
      ', al dólar de hoy. Después ya no cambia: lo que costó, costó.';
}

// Enseña el precio en la otra moneda mientras se escribe, para que nadie tenga
// que fiarse de una cuenta mental delante del cliente.
function equivalencia() {
  const n = parseFloat($('f-precio').value) || 0;
  const m = $('f-precio-moneda').value;
  const otra = m === 'USD' ? 'CUP' : 'USD';
  const c = convertir(n, m, otra);
  $('f-equivale').innerHTML = !n ? ''
    : c === null ? 'Pon el valor del dólar en Ajustes para ver el precio en ' + otra + '.'
    : 'Cobrando en ' + otra + ' serían <b>' + dinero(otra === 'USD' ?
        Math.round(c * 100) / 100 : Math.round(c), otra) + '</b>.';
}

async function guardarSinStock() {
  const permitir = $('sin-stock').checked;
  try {
    const r = await api('/api/vender-sin-stock', { method: 'POST',
      body: JSON.stringify({ permitir }) });
    VENDER_SIN_STOCK = !!r.vender_sin_stock;
    toast(VENDER_SIN_STOCK ? 'La caja ya no te frenará' : '✓ No se venderá lo que no está');
  } catch (e) { alert('No se pudo guardar: ' + e.message); $('sin-stock').checked = !permitir; }
}

// ─── La moneda del negocio ────────────────────────────────────
// Cambiarla convierte TODOS los costos guardados, de una vez. Por eso pide el
// cambio, avisa con todas las letras y hace falta confirmar dos veces: no hay
// botón para deshacerlo, solo la copia de seguridad.
function alElegirMonedaBase() {
  const nueva = $('mb-moneda').value;
  $('mb-caja').style.display = nueva === MONEDA_BASE ? 'none' : 'block';
  if (nueva !== MONEDA_BASE && !$('mb-tasa').value && TASA) $('mb-tasa').value = TASA;
}

async function cambiarMonedaBase() {
  const nueva = $('mb-moneda').value;
  const tasa = parseFloat($('mb-tasa').value) || 0;
  if (nueva === MONEDA_BASE) return;
  if (!(tasa > 0)) { toast('⚠ Pon a cuánto está el dólar'); $('mb-tasa').focus(); return; }
  if (!confirm('Se van a convertir a ' + nueva + ' los costos de TODOS los productos, ' +
      'movimientos y ventas, al cambio de ' + tasa + '.\n\nNo hay forma de deshacerlo ' +
      'salvo recuperando una copia de seguridad.\n\n¿Hiciste la copia?')) return;
  if (!confirm('Última pregunta: ¿el dólar está a ' + tasa + '?\n\nSi te equivocas aquí, ' +
      'todos los costos del negocio quedan mal.')) return;
  try {
    const r = await api('/api/moneda-base', { method: 'POST',
      body: JSON.stringify({ moneda: nueva, tasa }) });
    MONEDA_BASE = r.moneda_base;
    $('mb-caja').style.display = 'none';
    $('mb-aviso').innerHTML = '<div class="pista">Hecho: el negocio se mide en <b>' +
      r.moneda_base + '</b>. Se convirtieron ' + r.filas + ' filas.</div>';
    toast('✓ El negocio se mide en ' + r.moneda_base);
    await cargarTasa();
    await cargarCatalogo();
  } catch (e) { alert('No se pudo cambiar: ' + e.message); }
}

// ─── Ajustes ──────────────────────────────────────────────────
// La lista de «por dónde vamos» se quitó al terminarla: era el mapa de la
// obra, y con la obra hecha solo ocupaba sitio en Ajustes.

async function cargarEstado() {
  try {
    const d = await api('/api/salud');
    $('e-sitios').textContent = d.sitios;
    $('e-prods').textContent = d.productos;
    $('e-movs').textContent = d.movimientos;
    $('e-ventas').textContent = d.ventas;
    $('ver').textContent = 'v' + d.version;
    SALUD = d;
  } catch (e) { /* sin conexión: las cifras se quedan con la raya, y ya se ve */ }

  $('lista-sitios').innerHTML = SITIOS.map(s => `<div class="fila">
    <span>${esc(s.nombre)}</span>
    <b style="font-size:12px;color:var(--texto3)">${s.tipo === 'almacen' ? 'Almacén' : 'Punto de venta'}</b>
  </div>`).join('') || '<div class="vacio">Sin sitios</div>';

  // La tarjeta del sello solo si esta copia lo tiene. Una copia detrás de
  // nginx va con certificado de verdad: ahí no hay nada que instalar, y el
  // enlace llevaría a una página que no existe.
  $('tarjeta-sello').hidden = !(SALUD && SALUD.hay_sello);
}

// Olvidar el sello apuntado de otra copia, para el día que esa copia se
// reinstala desde cero (ver DECISIONES.md #13).
async function olvidarSello() {
  const url = $('sy-url').value.trim();
  if (!url) return toast('Escribe primero la dirección de la otra copia');
  if (!confirm('¿Olvidar el sello apuntado de ' + url + '?\n\n' +
    'La próxima sincronización aceptará el sello que conteste, sea cual sea. ' +
    'Hazlo solo si sabes que esa copia se reinstaló.')) return;
  try {
    await api('/api/sync/olvidar-sello', { method: 'POST', body: JSON.stringify({ url }) });
    toast('Sello olvidado');
  } catch (e) { toast(e.message); }
}

// ─── Arranque ────────────────────────────────────
['in-usuario','in-pin'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') entrar(); }));
$('ad-pin').addEventListener('keydown', e => { if (e.key === 'Enter') crearAdmin(); });
$('caja-busq').addEventListener('input', renderResultados);
['busq', 'f-cat', 'f-orden', 'f-local'].forEach(id =>
  $(id).addEventListener(id === 'busq' ? 'input' : 'change', renderLista));
['alm-busq', 'alm-cat', 'alm-filtro'].forEach(id =>
  $(id).addEventListener(id === 'alm-busq' ? 'input' : 'change', renderAlmacen));
$('iv-busq').addEventListener('input', () => buscarEnModal('iv-busq', 'iv-resultados', 'alaInversion', true));
$('f-precio').addEventListener('input', equivalencia);
// El precio manda en la comisión cuando es un porcentaje: sin esto, la pista
// seguiría diciendo lo que tocaba con el precio anterior.
$('f-precio').addEventListener('input', alCambiarComision);
$('f-precio-moneda').addEventListener('change', alCambiarComision);
['f-costo', 'f-costorepo'].forEach(id => $(id).addEventListener('input', equivalenciaCosto));
$('f-precio-moneda').addEventListener('change', equivalencia);
$('ci-busq').addEventListener('input', () => buscarEnModal('ci-busq', 'ci-resultados', 'alConteo'));
['ci-efectivo','ci-transfer'].forEach(id => $(id).addEventListener('input', compararCaja));
$('mov-busq').addEventListener('input', () => buscarEnModal('mov-busq', 'mov-resultados', 'elegirMovProducto', true));
$('des-busq').addEventListener('input', () => buscarEnModal('des-busq', 'des-resultados', 'alDespacho'));
// Enter añade al carro. Sirve para teclear rápido y, si algún día compran un
// lector de mostrador —que para el navegador es un teclado veloz que termina en
// Enter—, funcionará sin tocar una línea de código.
$('caja-busq').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const q = ($('caja-busq').value || '').trim().toLowerCase();
  if (!q) return;
  const vivos = productosAqui();
  const exacto = vivos.find(p => (p.codigo || '').toLowerCase() === q ||
                                 (p.codigo_barra || '').toLowerCase() === q);
  if (exacto) return alCarro(exacto.id);
  const coincide = vivos.filter(p =>
    (p.nombre || '').toLowerCase().includes(q) ||
    (p.codigo || '').toLowerCase().includes(q) ||
    (p.codigo_barra || '').toLowerCase().includes(q));
  if (coincide.length === 1) alCarro(coincide[0].id);
  else if (!coincide.length) toast('⚠ Ningún producto con «' + q + '»');
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('velo-ficha').classList.contains('abierto')) cerrarFicha();
});

arrancar();
// ═══════════════════════════════════════════════════════════════
//  LOS AVISOS
// ═══════════════════════════════════════════════════════════════
// Que la aplicación avise sola de lo que hay que atender.
//
// Dos capas, y la de abajo es la que importa:
//   1. La CAMPANITA, que se ve al abrir la aplicación. Funciona siempre: sin
//      internet, sin permisos y en cualquier teléfono.
//   2. El AVISO DEL TELÉFONO, el que sale arriba con sonido. Ese hace falta
//      pedirlo, y solo llega con la aplicación abierta.
// Si la segunda no está, la primera sigue haciendo su trabajo. Al revés no:
// por eso el aviso del sistema nunca es el único sitio donde se entera uno.
//
// Nada de esto se guarda en una lista: se calcula de lo que está sin atender.
// Hoy todo lo que se avisa lo sabe este DISPOSITIVO —la mercancía agotándose, la
// versión nueva—, y el servidor manda su parte por si algún día hay algo que
// solo sepa él.
let AVISOS = [], VERSION_MIA = null, VERSION_NUEVA = null;
const CADA_AVISOS = 3 * 60 * 1000;

async function cargarAvisos() {
  const locales = avisosDelDispositivo();
  try {
    const d = await api('/api/avisos');
    AVISOS = (d.avisos || []).concat(locales);
  } catch (e) {
    // Sin servidor, al menos lo del dispositivo. Un fallo de red aquí no se pinta:
    // estar sin conexión es lo normal (DECISIONES.md #15).
    AVISOS = locales;
  }
  pintarBurbuja();
  if ($('velo-avisos').classList.contains('abierto')) pintarAvisos();
  anunciarLosNuevos();
}

// Lo que solo sabe este dispositivo. La mercancía se mira del sitio en el que se
// está: al de al lado no le sirve de nada saber que aquí se acabó el cable.
function avisosDelDispositivo() {
  const fuera = [];
  if (puedo('gestionar_inventario', 'vender', 'ver_catalogo')) {
    // Los de aquí (#45): avisar de que se acabó algo que esta tienda no ha tenido
    // en su vida es enseñar a no hacer caso de la campanita.
    const bajos = productosAqui().filter(p => p.stock_min > 0 &&
      Number(STOCK[p.id] || 0) <= p.stock_min);
    if (bajos.length) {
      const sitio = (SITIOS.find(s => s.id === sitioActual()) || {}).nombre || 'este sitio';
      const agotados = bajos.filter(p => Number(STOCK[p.id] || 0) <= 0).length;
      fuera.push({
        // El id lleva los productos dentro a propósito: mientras sean los
        // mismos es el mismo aviso y no vuelve a sonar; en cuanto se acaba otra
        // cosa, es un aviso nuevo y sí suena.
        id: 'stock:' + bajos.map(p => p.id).sort().join(','),
        tipo: 'stock', cuando: new Date().toISOString(), ir: 'almacen',
        titulo: agotados ? agotados + (agotados === 1 ? ' producto agotado' : ' productos agotados')
                         : bajos.length + (bajos.length === 1 ? ' producto por acabarse' : ' productos por acabarse'),
        texto: 'En ' + sitio + ': ' + bajos.slice(0, 3).map(p => p.nombre).join(', ') +
               (bajos.length > 3 ? ' y ' + (bajos.length - 3) + ' más' : '') + '.',
      });
    }
  }
  if (VERSION_NUEVA) fuera.push({
    id: 'version:' + VERSION_NUEVA, tipo: 'version', cuando: new Date().toISOString(),
    ir: 'version', titulo: 'Hay una versión nueva de D´Padrones',
    // Sin números de versión: en la barra del teléfono no le dicen nada a nadie.
    // Quien los necesite los tiene al pie de Ajustes y en la tarjeta de la Caja.
    texto: 'Tócalo para actualizar este dispositivo. Tarda unos segundos, hace falta ' +
           'internet y no se pierde nada de lo que tengas a medias.',
  });
  return fuera;
}

function pintarBurbuja() {
  const n = AVISOS.length;
  const b = $('avisos-n');
  b.textContent = n > 9 ? '9+' : n;
  b.hidden = !n;
}

function abrirAvisos() {
  $('velo-avisos').classList.add('abierto');
  pintarAvisos();
  cargarAvisos();
}
function cerrarAvisos() { $('velo-avisos').classList.remove('abierto'); }

function pintarAvisos() {
  const puede = 'Notification' in window;
  $('av-permiso').style.display = puede && Notification.permission === 'default' ? 'block' : 'none';
  $('av-permiso-no').style.display = puede && Notification.permission === 'denied' ? 'block' : 'none';
  $('av-lista').innerHTML = AVISOS.length ? AVISOS.map((a, i) => `
    <div class="aviso1 ${esc(a.tipo)}" onclick="irAlAviso(${i})">
      <div style="flex:1">
        <div class="t">${esc(a.titulo)}</div>
        <div class="s">${esc(a.texto)}</div>
      </div>
      <div class="c">${fechaHora(a.cuando)}</div>
    </div>`).join('')
    : '<div class="vacio">Nada pendiente.<br><br>Aquí aparece la mercancía que se ' +
      'está acabando en este local y el aviso de que hay una versión nueva de la ' +
      'aplicación.</div>';
}

function irAlAviso(i) {
  const a = AVISOS[i];
  if (!a) return;
  cerrarAvisos();
  if (a.ir === 'version') return traerVersionNueva();
  if (a.ir === 'almacen') {
    const btn = document.querySelector('nav button[data-p="almacen"]');
    if (btn) irA('almacen', btn);
  }
}

// ─── El aviso del teléfono ───────────────────────────────────
// Solo se anuncia lo que este dispositivo no ha anunciado ya. La lista de anunciados
// vive AQUÍ y no en el servidor: es «a ti ya te lo enseñé», y eso es de cada
// dispositivo. Si viviera en el servidor, el primero en verlo dejaría a los demás
// sin enterarse.
const YA_AVISADOS = 'dp_avisados';
function leidosAnunciados() {
  try { return JSON.parse(localStorage.getItem(YA_AVISADOS) || '[]'); } catch (e) { return []; }
}
function anunciarLosNuevos() {
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    // Aunque no haya permiso se apunta lo que hay, o el día que lo dé saldrían
    // de golpe veinte avisos viejos.
    guardarAnunciados(AVISOS.map(a => a.id));
    return;
  }
  const ya = leidosAnunciados();
  const nuevos = AVISOS.filter(a => !ya.includes(a.id));
  guardarAnunciados(AVISOS.map(a => a.id));
  if (!nuevos.length) return;
  // Uno solo se enseña entero; varios de golpe se resumen, que veinte avisos
  // seguidos en la barra del teléfono no los lee nadie.
  if (nuevos.length === 1) avisoDelSistema(nuevos[0].titulo, nuevos[0].texto);
  else avisoDelSistema(nuevos.length + ' avisos que atender',
    nuevos.slice(0, 3).map(a => a.titulo).join(' · ') +
    (nuevos.length > 3 ? ' · y ' + (nuevos.length - 3) + ' más' : ''));
}
function guardarAnunciados(ids) {
  // Se guardan también los que ya no están, por si vuelven a salir en el mismo
  // rato; con un tope, que esto no puede crecer sin fin en un teléfono.
  const todos = [...new Set(ids.concat(leidosAnunciados()))].slice(0, 200);
  try { localStorage.setItem(YA_AVISADOS, JSON.stringify(todos)); } catch (e) {}
}

async function pedirPermisoAvisos() {
  try {
    const r = await Notification.requestPermission();
    pintarAvisos();
    if (r === 'granted') avisoDelSistema('Avisos activados',
      'Así se verán en este teléfono los avisos de D´Padrones.');
    else toast('La campanita de la aplicación sigue avisando igual.');
  } catch (e) { toast('Este navegador no sabe hacer eso'); }
}

// Se pinta a través del service worker y no con el constructor suelto: en Android
// el segundo no funciona en una aplicación instalada, y es justo donde se usa.
async function avisoDelSistema(titulo, texto) {
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(titulo, {
      body: texto, icon: 'img/icono-192.png', badge: 'img/icono-192.png',
      tag: 'dpadrones-avisos', renotify: true,
    });
  } catch (e) { /* sin service worker no hay aviso, y la campanita ya está */ }
}

// ═══════════════════════════════════════════════════════════════
//  LAS ACTUALIZACIONES
// ═══════════════════════════════════════════════════════════════
// La versión REAL de este dispositivo sale del nombre de la caja del service
// worker: es la única forma fiable de saber si una actualización entró
// (DECISIONES.md #7).
//
// Y hace falta poder forzarla desde la propia aplicación. El navegador se trae
// el service worker nuevo cuando le parece, y mientras tanto sigue sirviendo el
// código guardado: recargar con Ctrl+Shift+R no vale, porque eso salta la caché
// del navegador y no la del service worker, que es otra. En una PC se arregla
// abriendo la consola; en un teléfono no hay consola, y la única salida era
// cerrar y abrir la aplicación varias veces a ver si sonaba la flauta. Pasó de
// verdad el 13 de agosto, con el dueño delante.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

async function versionDelDispositivo() {
  if (!('caches' in window)) return null;
  const buscar = async () => {
    const ks = await caches.keys();
    const c = (ks || []).filter(k => k.indexOf('dp-v') === 0).sort().pop();
    // Se le quita el prefijo para comparar con lo que sirve `/api/salud`, que lo
    // recorta igual (`server.js`, VERSION_FRONT). Hasta el 31-ago aquí se recortaba
    // un prefijo que no existe en ninguna caja, así que no recortaba nada: el cartel
    // de «hay versión nueva» no se apagaba ni después de actualizar de verdad.
    return c ? c.replace(/^dp-/, '') : null;
  };
  try {
    let c = await buscar();
    // La primera vez —y justo después de actualizar— la caja todavía se está
    // llenando cuando se mira, y salía un guion donde tenía que salir la
    // versión. Se espera a que el service worker esté en pie, con un tope: si
    // no llega, es peor quedarse esperando que enseñar un guion.
    if (!c && 'serviceWorker' in navigator) {
      await Promise.race([navigator.serviceWorker.ready,
                          new Promise(r => setTimeout(r, 6000))]);
      c = await buscar();
    }
    return c;
  } catch (e) { return null; }
}

// Compara lo que tiene este dispositivo con lo que sirve el servidor. Sin internet
// falla en silencio: aquí estar sin conexión es lo normal y llenar la pantalla
// de rojo por eso enseña a ignorar los avisos de verdad (DECISIONES.md #15).
async function mirarVersiones() {
  const mia = await versionDelDispositivo();
  VERSION_MIA = mia;
  if (mia) { $('ver-sw').textContent = mia; $('ver-sw2').textContent = mia; }
  let suya = null;
  try {
    const r = await fetch('/api/salud', { cache: 'no-store' });
    suya = (await r.json()).front || null;
  } catch (e) { return { mia, suya: null }; }
  if (suya) $('ver-servidor').textContent = suya;
  const vieja = !!(mia && suya && mia !== suya);
  $('aviso-version').style.display = vieja ? 'block' : 'none';
  if (vieja) { $('version-vieja').textContent = mia; $('version-nueva').textContent = suya; }
  // La versión nueva también entra en la campanita, para que todo lo que pide
  // hacer algo esté en el mismo sitio.
  VERSION_NUEVA = vieja ? suya : null;
  return { mia, suya };
}

// Se tira el service worker y sus cajas, y se recarga. Es de bruto, y es lo
// único que funciona siempre. No se pierde ningún dato: en esas cajas solo hay
// archivos del programa —el HTML, los estilos, el código—, nunca ventas ni
// inventario, que viven en el servidor. Al recargar se registra de nuevo y el
// dispositivo vuelve a poder trabajar sin internet.
async function traerVersionNueva() {
  toast('Trayendo la versión nueva…');
  try {
    if ('serviceWorker' in navigator)
      for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    if ('caches' in window)
      for (const k of await caches.keys()) await caches.delete(k);
  } catch (e) { /* si algo de esto falla, la recarga de abajo aún puede servir */ }
  // Con «true» no basta en los navegadores de hoy: lo que hace falta es que la
  // dirección no sea la misma, para que no conteste ninguna caché intermedia.
  location.replace(location.pathname + '?v=' + Date.now());
}

async function buscarActualizacion() {
  $('ver-aviso').innerHTML = '<div class="pista">Comprobando si hay una versión nueva…</div>';
  const { mia, suya } = await mirarVersiones();
  if (!suya) {
    $('ver-aviso').innerHTML = '<div class="aviso">No se pudo comprobar si hay una versión ' +
      'nueva. Comprueba que hay internet y vuelve a intentarlo.</div>';
    return;
  }
  if (mia && mia === suya) {
    $('ver-aviso').innerHTML = '<div class="pista" style="color:var(--marca-claro)">' +
      '✓ Este dispositivo ya tiene la última versión.</div>';
    return;
  }
  $('ver-aviso').innerHTML = '<div class="aviso">Hay una versión nueva (' + esc(suya) +
    '). Trayéndola…</div>';
  traerVersionNueva();
}

// Al arrancar se mira una vez, y luego cada media hora: una máquina de un local
// se queda abierta el día entero y nadie va a entrar en Ajustes a comprobarlo.
mirarVersiones();
setInterval(mirarVersiones, 30 * 60 * 1000);
