// Comprobaciones de las pantallas: cosas que el navegador enseña o esconde y
// que no se ven probando la API.
//
// Existe por un fallo real: la capa de "entrar" tapaba toda la aplicación y
// nunca se escondía al iniciar sesión. El usuario metía su PIN correcto, la
// aplicación cargaba detrás, y él seguía viendo el formulario convencido de
// que no entraba. La API estaba perfecta y por eso no lo cazó ninguna prueba.
//
//   node pruebas/pantallas.js

const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(raiz, 'public/estilos.css'), 'utf8');
const html = fs.readFileSync(path.join(raiz, 'public/index.html'), 'utf8');
const js = fs.readFileSync(path.join(raiz, 'public/app.js'), 'utf8');
const sw = fs.readFileSync(path.join(raiz, 'public/sw.js'), 'utf8');

let ok = 0, mal = 0;
const comp = (nombre, cierto) => {
  if (cierto) { ok++; console.log('  ok   ' + nombre); }
  else { mal++; console.log('  MAL  ' + nombre); }
};

console.log('\n=== La capa de entrar se esconde al entrar ===');
comp('#pantalla-entrar nace escondida',
  /#pantalla-entrar\s*\{[^}]*display\s*:\s*none/.test(css));
comp('solo se ve con body.entrando',
  /body\.entrando\s+#pantalla-entrar\s*\{[^}]*display\s*:\s*flex/.test(css));
comp('el body arranca en modo entrando',
  /<body class="[^"]*entrando/.test(html));
comp('entrarEnLaApp quita la clase',
  /function entrarEnLaApp[\s\S]{0,200}classList\.remove\('entrando'\)/.test(js));
comp('cerrarSesionLocal la vuelve a poner',
  /function cerrarSesionLocal[\s\S]{0,200}classList\.add\('entrando'\)/.test(js));
comp('si no hay administrador, se queda en la capa',
  /!e\.hay_admin[\s\S]{0,300}classList\.add\('entrando'\)/.test(js));

console.log('\n=== Todo lo que el código busca existe en el HTML ===');
// Los del HTML y también los que el propio código crea al pintar (los que
// aparecen dentro de un id="..." en app.js). Si no, un elemento generado al
// vuelo se denunciaría como fantasma.
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
for (const m of js.matchAll(/id="([a-zA-Z][\w-]*)"/g)) ids.add(m[1]);
const buscados = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]));
const rotos = [...buscados].filter(i => !ids.has(i));
comp('ningún id fantasma' + (rotos.length ? ': ' + rotos.join(', ') : ''), !rotos.length);

// Y ninguno REPETIDO, que es peor que uno que falta: getElementById devuelve el
// primero y el otro se queda muerto, sin dar error en ninguna parte. Pasó con
// «fo-titulo», que era a la vez el título de la tarjeta del saldo y el de la
// ventana de apuntar: al abrir «Ingreso» se renombraba la tarjeta de la
// pantalla y la ventana seguía diciendo «Retiro».
const vistos = new Map();
for (const m of html.matchAll(/id="([^"]+)"/g)) vistos.set(m[1], (vistos.get(m[1]) || 0) + 1);
const repes = [...vistos].filter(([, n]) => n > 1).map(([i]) => i);
comp('ningún id repetido' + (repes.length ? ': ' + repes.join(', ') : ''), !repes.length);

console.log('\n=== Toda clase usada tiene estilo ===');
const clases = new Set();
for (const m of (html + js).matchAll(/class=["'`]([^"'`]+)["'`]/g)) {
  // Una clase armada con una expresión (class="x${...}") no se puede leer así:
  // se saca lo que va suelto y se ignora el trozo calculado.
  m[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)
    .filter(c => /^[a-zA-Z][\w-]*$/.test(c)).forEach(c => clases.add(c));
}
for (const m of js.matchAll(/classList\.(?:add|remove|toggle)\('([^']+)'\)/g)) clases.add(m[1]);
const sinEstilo = [...clases].filter(c =>
  !new RegExp('[.]' + c.replace(/[^\w-]/g, '') + '[^\\w-]').test(css));
comp('ninguna clase huérfana' + (sinEstilo.length ? ': ' + sinEstilo.join(', ') : ''), !sinEstilo.length);

console.log('\n=== Las funciones que llaman los botones existen ===');
const PALABRAS = new Set(['if', 'for', 'while', 'return', 'switch', 'catch', 'typeof']);
const llamadas = new Set();
for (const m of html.matchAll(/on\w+="([^"]*)"/g))
  for (const c of m[1].matchAll(/(\w+)\s*\(/g))
    if (!PALABRAS.has(c[1])) llamadas.add(c[1]);
const definidas = new Set([...js.matchAll(/function\s+(\w+)/g)].map(m => m[1]));
// Las del propio navegador no hace falta definirlas
['getElementById', 'querySelector', 'reload', 'print', 'click', 'focus', 'remove'].forEach(f => definidas.add(f));
const perdidas = [...llamadas].filter(f => !definidas.has(f));
comp('ningún botón llama al vacío' + (perdidas.length ? ': ' + perdidas.join(', ') : ''), !perdidas.length);

console.log('\n=== Se puede instalar en el teléfono (PWA) ===');
// El navegador pide CUATRO cosas y no dice cuál falta: manifiesto enlazado,
// iconos de 192 y 512, un service worker con «fetch», y HTTPS. Si falta una,
// simplemente no aparece «instalar» y nadie sabe por qué.
comp('el HTML enlaza el manifiesto', /<link rel="manifest" href="manifest\.json">/.test(html));
const manifiesto = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(raiz, 'public/manifest.json'), 'utf8')); }
  catch (e) { return null; }
})();
comp('manifest.json existe y se puede leer', !!manifiesto);
if (manifiesto) {
  comp('tiene nombre y nombre corto', !!manifiesto.name && !!manifiesto.short_name);
  comp('short_name cabe en el icono (12 letras o menos)',
    (manifiesto.short_name || '').length <= 12);
  comp('arranca en su sitio y se abre como aplicación',
    !!manifiesto.start_url && manifiesto.display === 'standalone');
  comp('lleva colores, para que la pantalla de carga no salga en blanco',
    /^#[0-9a-f]{6}$/i.test(manifiesto.background_color || '') &&
    /^#[0-9a-f]{6}$/i.test(manifiesto.theme_color || ''));

  const iconos = manifiesto.icons || [];
  const tiene = t => iconos.some(i => (i.sizes || '').split(' ').includes(t));
  comp('icono de 192', tiene('192x192'));
  comp('icono de 512', tiene('512x512'));
  // Sin uno "maskable", Android mete el icono cuadrado dentro de un círculo
  // blanco y queda como una pegatina mal puesta.
  comp('icono «maskable», para que Android no lo recorte mal',
    iconos.some(i => (i.purpose || '').split(' ').includes('maskable')));

  const faltan = iconos.map(i => i.src).filter(s => !fs.existsSync(path.join(raiz, 'public', s)));
  comp('todos los iconos existen de verdad' + (faltan.length ? ': faltan ' + faltan.join(', ') : ''),
    !faltan.length);
  // El service worker tiene que guardarlos: si no, el primer arranque sin
  // internet abre sin icono ni colores.
  comp('el service worker se guarda el manifiesto y los iconos',
    sw.includes('./manifest.json') && iconos.every(i => sw.includes('./' + i.src)));
}
comp('el iPhone tiene su icono (no lee el manifiesto)',
  /rel="apple-touch-icon"/.test(html) &&
  fs.existsSync(path.join(raiz, 'public/img/apple-touch-icon.png')));
comp('el service worker atiende peticiones (si no, no se puede instalar)',
  /addEventListener\('fetch'/.test(sw));
comp('y alguien lo registra', /serviceWorker[\s\S]{0,80}register\(/.test(js));

console.log('\n=== Inversiones y las dos monedas ===');
comp('la pantalla de Dinero tiene sus tres pestañas',
  ['t-fondo', 't-inversiones', 't-comisiones'].every(i => html.includes('id="' + i + '"')));
// Lo que se compra con una inversión se reparte entre los sitios ahí mismo.
comp('la inversión reparte cada producto entre los sitios',
  /function repartirLinea/.test(js) && /reparto/.test(js));
comp('y no deja repartir más de lo comprado sin decirlo',
  /Estás repartiendo/.test(js));
comp('y el PDF lleva el logo, el nombre y el eslogan',
  /function cabeceraPDF[\s\S]{0,300}MARCA\.logo[\s\S]{0,200}MARCA\.nombre[\s\S]{0,200}MARCA\.lema/.test(js));
console.log('\n=== Ajustes se entra por secciones, no por una lista infinita ===');
// Eran quince tarjetas seguidas y el dueño se perdía buscando cualquier cosa.
comp('hay un índice con sus apartados', /id="aj-indice"/.test(html) &&
  (html.match(/class="ajIndice"/g) || []).length >= 4);
comp('cada botón del índice abre su apartado',
  ['negocio', 'gente', 'copias', 'dispositivo']
    .every(s => html.includes('id="aj-' + s + '"') && html.includes("abrirAjustes('" + s + "')")));
comp('y desde dentro se vuelve al índice',
  /function volverAjustes/.test(js) && /onclick="volverAjustes\(\)"/.test(html));
comp('al entrar en Ajustes se empieza por el índice',
  /pantalla === 'ajustes'[\s\S]{0,80}volverAjustes\(\)/.test(js));
comp('un apartado sin nada que ver no sale en el índice',
  /function ajustesSegunPermisos/.test(js) && /ajustesSegunPermisos\(\)/.test(js));
// Dos tarjetas se llamaban «Copia de seguridad» y eran cosas distintas.
comp('ya no hay dos tarjetas con el mismo nombre',
  /<h2>Juntar dispositivos<\/h2>/.test(html) &&
  (html.match(/<h2>Copias? de seguridad<\/h2>/g) || []).length === 1);

console.log('\n=== Las copias de seguridad se ven ===');
comp('hay una tarjeta de salvas en Ajustes', /id="sa-lista"/.test(html));
comp('y se cargan al entrar en Ajustes',
  /pantalla === 'ajustes'[\s\S]{0,220}cargarSalvas\(\)/.test(js));
comp('se puede salvar a mano y descargar la última',
  /function salvarAhora/.test(js) && /function bajarUltimaSalva/.test(js));

console.log('\n=== El almacén principal es el mirador del negocio ===');
// La pantalla del resumen por período estuvo ROTA del todo: el servidor pasó a
// mandar «por_moneda» al separar las dos monedas y la pantalla seguía leyendo
// «por_pago». Object.entries(undefined) revienta, y como todo el contenido se
// pintaba de una vez, la pantalla se quedaba en blanco sin decir nada. Esta
// comprobación es para que ese campo no vuelva por la puerta de atrás.
comp('el resumen lee el cobrado por moneda y no el campo viejo',
  /por_moneda/.test(js) && !/por_pago/.test(js));
comp('el resumen y el fondo piden el desglose del negocio',
  /cargarResumen[\s\S]{0,900}\/api\/negocio/.test(js) &&
  /cargarFondo[\s\S]{0,900}\/api\/negocio/.test(js));
// Y con su propio catch: esa puerta se le puede cerrar a quien no ve el negocio
// entero, y si tumbara el Promise.all la pantalla de Dinero se quedaría en blanco
// entera. Le pasaba al encargado de una tienda (decisión #39).
comp('y si esa puerta se cierra, no se lleva por delante la pantalla',
  /\/api\/negocio[^\n]*\.catch\(\(\) => null\)/.test(js));
comp('hay un hueco para la jornada de todos los sitios', /id="dia-negocio"/.test(html));
comp('y solo se pinta estando en el almacén principal',
  /if \(enElMirador\(\)\)[\s\S]{0,300}dia-negocio/.test(js));
comp('cuál es el almacén principal se decide como en el servidor: el primero que se creó',
  /function sitioPrincipal|const sitioPrincipal/.test(js) && /creado_en/.test(js));
comp('al entrar en el almacén principal, el inventario sale sumado',
  /almacenPintadoDe[\s\S]{0,300}alm-alcance'\)\.value = enElMirador\(\) \? 'todos' : 'sitio'/.test(js));
// Lo que pasó en un período y lo que hay hoy son dos cosas distintas: si se
// mezclan en una sola tabla, alguien leerá «tiene» donde pone «vendió».
comp('el desglose separa lo del período de lo que hay ahora',
  /Lo que se movió, por sitio/.test(js) && /Lo que hay ahora/.test(js));
comp('y el PDF del resumen lleva el mismo desglose',
  /function imprimirResumen[\s\S]{0,3000}Por sitio/.test(js));

console.log('\n=== La lista de inversiones no se queda con lo que creía ===');
// Una inversión se registró de verdad en el servidor y la pantalla siguió
// diciendo «Todavía no hay inversiones»: la respuesta se perdió y el refresco
// de la lista iba después. Ahora al cerrar la ventana se vuelve a preguntar.
comp('cerrar la ventana vuelve a pedir la lista',
  /function cerrarInversion\(\)[\s\S]{0,200}cargarInversiones\(\)/.test(js));
comp('y un fallo también la refresca, además de avisar donde se vea',
  /function falloInversion[\s\S]{0,300}toast\([\s\S]{0,120}cargarInversiones\(\)/.test(js));

console.log('\n=== El dinero de una inversión sale de una caja de verdad ===');
// El botón «Inversión» del fondo hacía la mitad del trabajo y confundía: lo
// apuntado con él no salía en la lista de inversiones.
comp('el fondo ya no tiene su propio botón de inversión',
  !/abrirFondo\('inversion'\)/.test(html));
comp('y la inversión dice de qué gaveta sale el dinero',
  /id="iv-sitio"/.test(html) && /sitio_id: \$\('iv-sitio'\)\.value/.test(js));
// Decisión #38 (21 de agosto de 2026): esa gaveta es siempre una de verdad. La
// opción que sacaba el dinero del montón desapareció del desplegable, y en su
// hueco está «Elige…», que obliga a decirlo.
comp('ya no se puede sacar el dinero del montón, sin decir de qué caja',
  !/Del fondo del negocio/.test(js));
comp('el desplegable obliga a elegir una caja',
  /\$\('iv-sitio'\)\.innerHTML = '<option value="">Elige…<\/option>'/.test(js));
comp('y no se guarda sin ella', /if \(!c\.sitio_id\)[\s\S]{0,120}iv-sitio/.test(js));
// Y debajo se enseña lo que hay en esa caja: sin eso, el importe se escribe a
// ciegas y el «no tienes ese dinero» solo aparece al registrar, con la inversión
// entera ya tecleada.
comp('debajo se ve cuánto hay en esa caja', /function pintarCajaInversion/.test(js) &&
  /onchange="pintarCajaInversion\(\)"/.test(html));
comp('y lo mismo en el apunte del fondo', /function pintarCajaFondo/.test(js) &&
  /onchange="pintarCajaFondo\(\)"/.test(html));
comp('se puede añadir dinero que no es mercancía',
  /onclick="anadirDineroInv\(\)"/.test(html) && /function anadirDineroInv/.test(js));
comp('y esa línea no pide reparto entre sitios, que no significaría nada',
  /Línea de DINERO[\s\S]{0,1200}En qué se fue/.test(js));
console.log('\n=== Las ganancias se ven en Dinero, dentro de cada sitio ===');
// Estaban en su propia tabla, aparte del dinero de cada sitio. Para saber qué
// había hecho una tienda había que juntar dos trozos de la pantalla a ojo.
comp('cada sitio lleva su ganancia en su tarjeta',
  /const hayGanancias = verGan/.test(js) && /Vendiendo por el mostrador/.test(js));
comp('y el total de la empresa va al final, con la misma forma',
  /tarjetaDeSitio\(neg\.total, neg\.ver_ganancias, true\)/.test(js) &&
  /TOTAL DE LA EMPRESA/.test(js));
comp('no se enseñan a quien no puede verlas',
  /tarjetaDeSitio\(p, neg\.ver_ganancias, false\)/.test(js) &&
  /const hayGanancias = verGan &&/.test(js));
comp('y ya no hay una tabla de ganancias aparte',
  !/id="fo-ganancias"/.test(html) && !/id="fo-ganancias-caja"/.test(html));
// El período estaba tres veces en la misma pantalla: el total arriba, las
// ganancias en el medio y el dinero por sitio abajo.
comp('el período sale en un solo sitio, no en tres',
  !/id="fo-ingreso"/.test(html) && !/id="fo-neto"/.test(html) &&
  !/fo-ingreso'\)/.test(js));

console.log('\n=== El service worker sube de versión ===');
comp('sw.js tiene su CACHE con versión', /const CACHE = 'dp-v[\d-]+'/.test(sw));
comp('la caché incluye los archivos del front',
  ["'./index.html'", "'./estilos.css'", "'./app.js'"].every(a => sw.includes(a)));

console.log('\n=== Y se puede forzar la actualización desde la aplicación ===');
// En un teléfono no hay consola del navegador: sin botón, la única salida era
// cerrar y abrir la aplicación a ver si sonaba la flauta. Pasó el 13-ago.
const servidor = fs.readFileSync(path.join(raiz, 'server.js'), 'utf8');
comp('el servidor dice qué versión del front sirve, sacada del propio sw.js',
  /VERSION_FRONT[\s\S]{0,400}const CACHE = '\(\[\^'\]\+\)'/.test(servidor) &&
  /front: VERSION_FRONT/.test(servidor));
comp('la aplicación compara la suya con la del servidor',
  /function mirarVersiones[\s\S]{0,600}\/api\/salud/.test(js));
comp('y lo hace al arrancar y cada cierto tiempo, no solo si alguien mira',
  /setInterval\(mirarVersiones/.test(js));
comp('si no coinciden, avisa en la caja', /id="aviso-version"/.test(html) &&
  /aviso-version'\)\.style\.display/.test(js));
comp('hay un botón para buscarla en Ajustes',
  /onclick="buscarActualizacion\(\)"/.test(html) && /function buscarActualizacion/.test(js));
comp('traer la nueva tira el service worker y sus cajas, y recarga',
  /function traerVersionNueva[\s\S]{0,700}unregister\(\)[\s\S]{0,300}caches\.delete[\s\S]{0,300}location\.replace/.test(js));
// Recargar a la misma dirección puede contestarlo una caché de por medio.
comp('y recarga con una dirección distinta, para que nadie conteste de memoria',
  /location\.replace\(location\.pathname \+ '\?v=' \+ Date\.now\(\)\)/.test(js));

console.log('\n=== El costo se guarda en la moneda del NEGOCIO ===');
// Convertía a pesos siempre, midiera el negocio en lo que midiera. Con la
// medida en dólares, un costo de 300 se guardaba como 36 000 y la ganancia de
// cada venta de ese producto salía absurda. Reportado el 14-ago-2026.
comp('la casilla del costo convierte a la moneda del negocio, no a pesos',
  /function costoEnBase[\s\S]{0,400}convertir\(n, m, MONEDA_BASE\)/.test(js));
comp('y ya no queda ningún «a pesos» escondido', !/costoEnCUP/.test(js));
comp('la casilla arranca en la moneda del negocio',
  /f-costo-moneda'\)\.value = MONEDA_BASE/.test(js));
comp('el costo del catálogo se enseña en esa moneda',
  !/pesos\(p\.costo/.test(js) && /costo ' \+ enBase\(p\.costo\)/.test(js));
comp('y un costo por encima del precio se marca, que casi siempre es eso',
  /function costoRaro/.test(js) && /costoRaro\(p\)/.test(js));
comp('la entrada de mercancía dice en qué moneda va el costo',
  /mov-costo-lbl'\)\.textContent = 'Costo por unidad \(' \+ MONEDA_BASE/.test(js));

console.log('\n=== Las dos monedas se enseñan, nunca se suman ===');
comp('los totales llevan la otra moneda al lado, solo para mirar',
  /const conRef = n =>/.test(js) && /conRef\(v\.ganancia\)/.test(js));
comp('la ganancia de la jornada y el valor del almacén también',
  /v-ganancia'\)\.textContent[\s\S]{0,80}conRef/.test(js) &&
  /alm-valor'\)\.textContent = conRef/.test(js));
comp('a cada trabajador se le puede pagar en su moneda',
  /id="pe-moneda-pago"/.test(html) && /moneda_pago: \$\('pe-moneda-pago'\)/.test(js));
comp('y el servidor la guarda sin dar por hecho ninguna',
  /const monedaPago = m =>/.test(servidor));
// El SUM de SQL sumaba el total de ventas en pesos con el de ventas en dólares.
comp('las comisiones ya no suman lo cobrado con un SUM a ciegas',
  !/COALESCE\(SUM\(v\.total\),0\) vendido/.test(servidor));

console.log('\n=== Cada sitio tiene su gaveta, y el dinero se puede mover ===');
comp('la unidad de medida se pregunta al crear un producto sobre la marcha',
  /id="velo-nuevoprod"/.test(html) && /id="np-um"/.test(html) &&
  /function confirmarProductoRapido/.test(js));
comp('hay una ventana para pasar dinero de un sitio a otro',
  /id="velo-traspaso"/.test(html) && /function guardarTraspaso/.test(js));
comp('el traspaso se apunta en dos mitades, como un traslado de mercancía',
  /ref_tipo: 'traspaso'[\s\S]{0,400}ref_tipo: 'traspaso'/.test(servidor));
comp('y no cuenta como dinero que entra ni que sale del negocio',
  /COALESCE\(ref_tipo,''\) <> 'traspaso'/.test(servidor));
comp('el fondo enseña primero el dinero de ESTE sitio',
  /id="fo-titulo"/.test(html) && /saldo_sitio/.test(js));
comp('antes de escribir el importe se ve cuánto hay en esa gaveta',
  /function pintarSaldoTraspaso/.test(js));

console.log('\n=== Sitio por sitio, con el mismo desglose que el negocio ===');
// Antes solo salía «entró / salió / en la gaveta», y para saber si esos 2 940
// fueron una inversión o un gasto había que bajar a los movimientos y sumarlo
// a ojo. Pedido por el dueño el 14 de agosto.
comp('cada sitio lleva los conceptos del período',
  /function tarjetaDeSitio/.test(js) &&
  ["'Retiros', 'retiro'", "'Inversiones', 'inversion'",
   "'Gastos', 'gasto'"].every(t => js.includes(t)));
// «Entró» a secas no decía si esos 3 000 fueron del mostrador o de un trabajo.
comp('y dice si el dinero entró por una venta o por otra cosa',
  ["'Ingresos por ventas', 'de_ventas'",
   "'Otros ingresos', 'de_otros'"].every(t => js.includes(t)) &&
  /f\.origen === 'venta' \? 'de_ventas'/.test(servidor));
comp('y el saldo del período, calculado por moneda y nunca sumando las dos',
  /const quedo = m => f\[m\]\.ingreso/.test(js) && /Saldo del período/.test(js));
// Los rótulos los eligió el dueño: son los que va a leer alguien de fuera.
comp('los rótulos son de oficina, no de conversación',
  !/Entró vendiendo|Entró por trabajos|>Quedó</.test(js) &&
  /Ingresos por ventas/.test(js) && /Otros ingresos/.test(js));
comp('los traspasos van en su propia casilla, no dentro de «entró»',
  /caja\[f\.tipo === 'ingreso' \? 'recibido' : 'mandado'\]/.test(servidor));
comp('un sitio sin nada que contar no llena la pantalla de ceros',
  /if \(!c && !u\) return '';/.test(js));

console.log('\n=== Dinero cabe en una pantalla, y no arranca en pesos ===');
// Cuatro tiendas de diez líneas cada una obligaban a bajar media pantalla para
// llegar al total. Ahora cada sitio se lee en una línea y se abre el que se
// quiera mirar.
comp('cada sitio se enseña plegado, con lo que le quedó a la vista',
  /<details class="tarjeta plegable"/.test(js) && /class="nmPleg"/.test(js) &&
  /\.plegable > summary\{/.test(css));
comp('el total del negocio viene abierto: es el resumen',
  /\$\{esTotal \? ' open' : ''\}/.test(js));
comp('los movimientos también se pliegan', /id="fo-cuenta"/.test(html));
comp('y los botones de dinero están juntos, no repartidos por la pantalla',
  /abrirFondo\('ingreso'\)[\s\S]{0,300}abrirFondo\('retiro'\)[\s\S]{0,300}abrirFondo\('gasto'\)/.test(html));
// El fallo que dejó una gaveta en −20 CUP: la casilla de moneda arrancaba en
// pesos aunque el negocio se midiera en dólares.
comp('las casillas de moneda del dinero empiezan en la del negocio',
  ["$('iv-moneda').value = (i && i.moneda) || MONEDA_BASE",
   "$('tr-moneda').value = MONEDA_BASE",
   "$('fo-moneda').value = MONEDA_BASE"].every(t => js.includes(t)));
comp('y una caja en negativo se dice, no se deja como un número raro',
  /const enRojo = g\.CUP < 0 \|\| g\.USD < 0/.test(js) &&
  /Esta caja está en /.test(js));

console.log('\n=== El período se puede mover, no solo elegir ===');
// Con «hoy / este mes / todo» no había forma de mirar un día de la semana
// pasada ni el mes de junio.
comp('se puede elegir día, semana, mes, año, entre dos fechas o todo',
  ['dia', 'semana', 'mes', 'ano', 'rango', 'todo']
    .every(v => html.includes('value="' + v + '"')));
comp('y hay flechas para ir al anterior y al siguiente',
  /id="fo-antes"/.test(html) && /id="fo-despues"/.test(html) &&
  /function moverPeriodo/.test(js));
// Guardar «desde» y «hasta» sueltos obligaría a recalcular los dos a mano en
// cada salto, y ahí se cuelan los días de más y los de menos.
comp('el período se guarda como un ancla y un tamaño',
  /let PERIODO = \{ tipo: 'mes', ancla:/.test(js));
comp('la semana va de lunes a domingo',
  /d\.getDate\(\) - \(\(d\.getDay\(\) \+ 6\) % 7\)/.test(js));
comp('y se escribe qué se está mirando, con letras',
  /function pintarPeriodo/.test(js) && /id="fo-cual"/.test(html));
comp('las flechas se esconden cuando no hay nada que mover',
  /fo-antes'\)\.style\.display = mueve/.test(js));

console.log('\n=== Cada apunte lleva a la operación que lo creó ===');
comp('los movimientos se pueden tocar', /onclick="verOrigen\(/.test(js));
comp('y se abre una ventana con el origen',
  /id="velo-origen"/.test(html) && /async function verOrigen/.test(js));
comp('la venta enseña su detalle, el sitio y el vendedor',
  /o\.tipo === 'venta'[\s\S]{0,700}Detalle de la venta/.test(js));
comp('la inversión se puede abrir entera', /Ver la inversión/.test(js));
comp('el traspaso enseña sus dos mitades', /o\.tipo === 'traspaso'/.test(js));
// Si no se dijera, uno se queda buscando un origen que no existe.
comp('y un apunte hecho a mano lo dice', /Apuntado a mano/.test(js));

console.log('\n=== Borrar datos: con todos los frenos puestos ===');
// Va contra la regla de que los apuntes no se borran (#2), así que está atado.
comp('está junto a las copias, para tropezarse antes con «Salvar ahora»',
  /id="tarjeta-borrar"/.test(html) &&
  html.indexOf('id="sa-lista"') < html.indexOf('id="tarjeta-borrar"'));
comp('nace escondido y solo lo ve el administrador',
  /id="tarjeta-borrar"[^>]*hidden/.test(html) &&
  /if \(!puedo\('\*'\\?\)\) \{ caja\.hidden = true; return; \}/.test(js));
comp('el servidor también lo comprueba, no solo la pantalla',
  /const soyAdmin = req =>/.test(servidor) &&
  /if \(!soyAdmin\(req\)\) return res\.status\(403\)/.test(servidor));
comp('hay que escribir la palabra, y el servidor la exige',
  /id="bo-palabra"/.test(html) &&
  /!== 'BORRAR'\)\n?\s*return res\.status\(400\)/.test(servidor));
comp('y además dos confirmaciones antes de mandar nada',
  /function borrarDatos[\s\S]{0,900}confirm\([\s\S]{0,600}confirm\(/.test(js));
comp('se hace una copia justo antes, y si falla no se borra',
  /copia = await salvar\('antes de borrar'\)/.test(servidor) &&
  /no se ha borrado nada/.test(servidor));
comp('se enseña cuánto hay de cada cosa antes de decidir',
  /\/api\/borrar\/vista-previa/.test(servidor) && /g\.cuantos/.test(js));
// Borrar el catálogo dejando las ventas dejaría apuntes de algo que ya no existe.
comp('lo que arrastra a otra cosa la marca solo', /function revisarBorrado/.test(js) &&
  /arrastrados\.push\(nec\)/.test(js));
comp('y avisa si hay más dispositivos, que allí no se borra',
  /id="bo-aviso-sync"/.test(html) && /hay_otras_copias/.test(servidor));

console.log('\n=== Cada cosa en su pantalla, y el dinero que sale con su caja ===');
// Preguntado por el dueño el 17 de agosto de 2026: «la parte de comisiones que sale
// en ajustes, ¿está bien que vaya en ajustes?». No lo estaba: pagarle a alguien es
// una operación de dinero, no un ajuste del negocio (DECISIONES.md #37).
comp('las comisiones viven en Dinero, con su pestaña',
  /<div id="t-comisiones"/.test(html) &&
  /pestanaDinero\('comisiones'/.test(html) && /cual === 'comisiones'\) cargarComisiones/.test(js));
// El mes y la lista tienen que estar DENTRO de la pantalla de dinero, no en
// Ajustes: si se quedaran allí, la pestaña saldría vacía y nadie sabría por qué.
const dinero = (html.match(/<section id="p-dinero"[\s\S]*?<\/section>/) || [''])[0];
comp('el mes y la lista de comisiones están dentro de esa pantalla',
  /id="com-mes"/.test(dinero) && /id="lista-comisiones"/.test(dinero));
// Se busca DENTRO del apartado de Ajustes y no en todo el archivo: la lista vive
// ahora en Dinero, que va antes, así que un patrón suelto la encuentra allí y la
// prueba pasa sin comprobar nada.
const ajGente = (html.match(/id="aj-gente"[\s\S]*?fin de La gente/) || [''])[0];
comp('en Ajustes ya no queda la lista, solo el aviso de dónde está',
  !/id="lista-comisiones"/.test(ajGente) && /Dinero → Comisiones/.test(ajGente));
// Y el dinero que SALE tiene que decir de qué caja. Se comprueba en el servidor,
// que es quien manda; esconder la opción en la pantalla es decoración (#10).
comp('el servidor exige el sitio en retiros, gastos e inversiones',
  /SALE_DE_UNA_CAJA = \['retiro', 'gasto', 'inversion'\]/.test(servidor) &&
  /function sitioDelApunte/.test(servidor));
comp('y lo comprueba tanto al apuntar como al corregir',
  (servidor.match(/sitioDelApunte\(/g) || []).length >= 3);
comp('la pantalla ya no ofrece «ninguno en concreto» en lo que sale',
  /exigeSitio \? '<option value="">Elige…<\/option>'/.test(js));

console.log('\n=== Las palabras de la pantalla ===');
// Pedido por el dueño: «hay palabras que no son muy profesionales».
// La única «aparato» que queda es el nombre de la columna de la tabla de
// sesiones, que viaja al servidor y no se ve en ninguna pantalla.
comp('se dice dispositivo, no aparato',
  !/aparato/i.test(html) &&
  (js.match(/aparato/gi) || []).length === (js.match(/aparato: navigator|'aparato' es el nombre/g) || []).length);
comp('los apartados de Ajustes tienen nombres de oficina',
  ['La empresa', 'Personal', 'Copias y dispositivos', 'Este dispositivo']
    .every(t => html.includes('>' + t + '<')));

console.log('\n=== La campanita ===');
comp('hay una campanita en la cabecera, con su burbuja',
  /id="btn-avisos"/.test(html) && /id="avisos-n"/.test(html) && /\.burbuja\{/.test(css));
comp('la lista sale de lo que está sin atender, no de una tabla de avisos',
  /app\.get\('\/api\/avisos'/.test(servidor) &&
  !/CREATE TABLE[^;]*avisos/i.test(fs.readFileSync(path.join(raiz, 'db/esquema.sql'), 'utf8')));
comp('se mira sola cada tanto, y solo con la pantalla encendida',
  /if \(!document\.hidden\) cargarAvisos\(\)/.test(js));
comp('atender algo la refresca',
  (js.match(/cargarAvisos\(\)/g) || []).length >= 5);
comp('tocar un aviso lleva a donde se atiende', /function irAlAviso/.test(js));

console.log('\n=== El aviso del teléfono, con cuidado ===');
// Pedir el permiso al abrir es lo que hace que la gente le dé a «Bloquear» sin
// leer, y entonces ya no hay forma de volver a preguntarlo.
comp('el permiso se pide con un botón, nunca al arrancar',
  /onclick="pedirPermisoAvisos\(\)"/.test(html) &&
  !/^\s*Notification\.requestPermission\(\)/m.test(js));
comp('y si está bloqueado se dice cómo desbloquearlo', /id="av-permiso-no"/.test(html));
// En Android, new Notification() no funciona en una aplicación instalada, que
// es justo donde se usa.
comp('el aviso lo pinta el service worker, no new Notification()',
  /reg\.showNotification\(/.test(js) && !/new Notification\(/.test(js));
comp('tocarlo trae la aplicación en vez de abrir otra copia',
  /notificationclick/.test(sw) && /'focus' in v/.test(sw));
comp('lo ya anunciado se apunta en el aparato, no en el servidor',
  /localStorage\.setItem\(YA_AVISADOS/.test(js));
// Si se apuntaran solo cuando hay permiso, el día que lo diera saldrían de
// golpe todos los avisos viejos.
comp('sin permiso también se apunta, para que no salgan veinte de golpe luego',
  /Notification\.permission !== 'granted'[\s\S]{0,220}guardarAnunciados/.test(js));
comp('la campanita funciona aunque el aviso del teléfono no esté',
  /catch \(e\) \{ \/\* sin service worker no hay aviso/.test(js));

console.log('\n' + (mal ? 'FALLAN ' + mal + ' de ' + (ok + mal) : 'TODO BIEN: ' + ok + ' comprobaciones'));
process.exit(mal ? 1 : 0);
