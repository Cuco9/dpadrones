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
// El ALMACÉN abre siempre en «solo lo que hay aquí», también en el almacén
// principal: lo pidió el dueño el 1-sep-2026, porque lo primero que quiere ver
// al entrar es su estante y no una suma. El mirador de la #22 se queda para
// Cierre y Dinero, que es donde se llevan las cuentas de todo.
comp('el almacén abre en «lo que hay aquí», también en el principal',
  /almacenPintadoDe[\s\S]{0,400}\$\('alm-alcance'\)\.value = 'sitio';/.test(js) &&
  !/alm-alcance'\)\.value = .{0,40}enElMirador/.test(js));
// Y el filtro abre en «Todo el catálogo»: el primer <option> es el que sale
// puesto. Filtrando por existencia, un producto recién creado no aparece y
// parece que no se guardó — que es justo lo que le pasó al dueño ese día.
comp('y el filtro abre en «Todo el catálogo», que va el primero',
  /<select id="alm-filtro">\s*(<!--[\s\S]*?-->\s*)?<option value="todos">/.test(html));

// Con un solo sitio, «todo el negocio» enseña exactamente lo mismo que «lo que
// hay aquí» y a cambio esconde los botones de Entrada y Merma, porque una
// entrada tiene que ir a un sitio concreto. Eso dejaba la pantalla de Almacén
// sin ninguna forma de meter mercancía, que es como el dueño se encontró la
// aplicación el 1-sep-2026: entraba, veía «Todo el negocio, sumado», ni un
// botón, y una lista vacía.
comp('con un solo sitio, el desplegable de alcance no se enseña',
  /const variosSitios = sitiosReales\(\)\.filter\(s => s\.activo !== 0\)\.length > 1/.test(js) &&
  /\$\('alm-alcance-caja'\)\.style\.display =\s*\(variosSitios && !enElMirador\(\)\) \? '' : 'none'/.test(js) &&
  /id="alm-alcance-caja"/.test(html));
// Y el mirador no cuenta como sitio para esto: no es un local entre los que
// repartir, es desde donde se miran todos (#48).
comp('y el almacén principal no cuenta como sitio al contarlos',
  /const sitiosReales = \(\) => SITIOS\.filter\(s => !esMirador\(s\.id\)\)/.test(js));
comp('y entonces el alcance se queda en «lo que hay aquí», pase lo que pase',
  /if \(!variosSitios\) \$\('alm-alcance'\)\.value = 'sitio'/.test(js));
// Que es lo que hace aparecer los botones: cambiarAlcanceAlmacen esconde la fila
// entera en la vista de todo el negocio.
comp('los botones de Entrada y Merma cuelgan del alcance, no del permiso a secas',
  /\$\('alm-acciones'\)\.style\.display = todos \? 'none' : 'flex'/.test(js));
comp('despachar se esconde cuando no hay otro sitio al que mandar',
  /\$\('btn-despachar'\)\.style\.display =[\s\S]{0,160}variosSitios && !enElMirador\(\) && puedo\('traslados_enviar'\)/.test(js) &&
  /id="btn-despachar"/.test(html));

// Y cuando la lista sale vacía, decir cuál de las dos cosas es. El almacén abre
// filtrando por «Con existencia», así que un catálogo recién creado —sin
// entradas todavía— salía entero vacío con un «Nada que mostrar con este
// filtro» que parecía que la aplicación no había guardado el producto.
comp('la lista vacía dice si es que no hay productos o que ninguno tiene existencia',
  /function almacenVacio\(filtro, antesDeExistencia, buscando\)/.test(js) &&
  // Y que la lista la LLAME: una función que nadie usa deja el aviso mudo igual.
  /\.join\(''\) : almacenVacio\(filtro, antesDeExistencia/.test(js) &&
  /Ninguno tiene existencia todavía/.test(js) &&
  /Todavía no hay ningún producto en el catálogo/.test(js));
comp('y ofrece verlos todos sin ir a buscar el filtro',
  /function verTodoElCatalogo\(\) \{ \$\('alm-filtro'\)\.value = 'todos'; renderAlmacen\(\); \}/.test(js));
// Solo dentro de renderAlmacen: en la Caja hay otro `filtro === 'con'` antes, y
// comparando sobre todo el archivo se comparaban dos trozos que no se hablan.
const cuerpoAlmacen = js.slice(js.indexOf('function renderAlmacen()'),
                              js.indexOf('function renderTransitos()'));
comp('el recuento se toma ANTES de filtrar por existencia, o siempre diría cero',
  cuerpoAlmacen.indexOf('const antesDeExistencia = lista.length;') > -1 &&
  cuerpoAlmacen.indexOf('const antesDeExistencia = lista.length;') <
  cuerpoAlmacen.indexOf("if (filtro === 'con') lista = lista.filter"));
comp('y buscar sin coincidencias no se confunde con un catálogo vacío',
  /Nada coincide con lo que buscas/.test(js));
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
// El 31-ago-2026 el cartel de «hay versión nueva» no se apagaba NUNCA, ni después
// de actualizar de verdad: el servidor le recortaba un prefijo al nombre de la caja
// y la aplicación le recortaba otro distinto, así que las dos versiones no podían
// salir iguales ni queriendo. No rompía nada —solo mentía—, y eso es más difícil de
// encontrar que un fallo que se ve. Aquí se exige que los dos recorten lo mismo, y
// que eso sea de verdad lo que lleva la caja delante.
const nombreCaja = (sw.match(/const CACHE = '([^']+)'/) || [])[1] || '';
const recorteServidor = (servidor.match(/\.replace\((\/\^[a-z-]+\/), ''\)/) || [])[1];
const recorteApp = (js.match(/c\.replace\((\/\^[a-z-]+\/), ''\)/) || [])[1];
comp('el servidor y la aplicación recortan el MISMO prefijo del nombre de la caja',
  !!recorteServidor && recorteServidor === recorteApp,
  JSON.stringify({ servidor: recorteServidor, aplicación: recorteApp }));
comp('y ese prefijo es el que la caja lleva de verdad',
  !!recorteServidor && nombreCaja.startsWith(recorteServidor.slice(2, -1)),
  JSON.stringify({ caja: nombreCaja, recorte: recorteServidor }));
// Y que no quede NINGÚN resto del prefijo viejo en ninguna parte. El del nombre
// de la caja tardó tres días en aparecer, y detrás venían nueve más escondidos en
// los nombres de las carpetas de usar y tirar de las pruebas. Ninguno rompía nada;
// por eso sobrevivieron. Se mira en todo lo escrito a mano, no solo en el front.
const aMano = [];
(function mirar(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'salvas') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) mirar(p);
    else if (/\.(js|html|css|sql|json)$/.test(e.name) && e.name !== 'package-lock.json') aMano.push(p);
  }
})(raiz);
const conResto = aMano.filter(p => /\bqs[-_]|\bQS_/.test(fs.readFileSync(p, 'utf8')))
  .map(p => path.relative(raiz, p));
comp('no queda ningún resto del prefijo de la aplicación de la que salió esta' +
  (conResto.length ? ': ' + conResto.join(', ') : ''), !conResto.length);

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
comp('y lo que se movió en el período, por moneda y nunca sumando las dos',
  /const quedo = m => f\[m\]\.ingreso/.test(js) && /Entró menos salió/.test(js));
// El rótulo de la cabecera decía «saldo» a secas, junto al nombre de la tienda,
// y eso se lee como «esto es lo que tiene»: filtrando un día se podía ver
// «-5.508» y entender que la tienda estaba en números rojos teniendo 142.195 en
// la caja.
comp('la cifra de la cabecera NO se llama «saldo», que se confunde con lo que hay',
  !/>saldo<\/div>/.test(js));
// Cambiar el rótulo evita el malentendido pero no contesta la pregunta, que es
// «¿y en qué queda mi caja?». La tarjeta es un ESTADO DE CUENTA y la cabecera
// enseña con cuánto se cerró el período.
comp('la cabecera dice con cuánto se cerró el período, que es lo que se preguntaba',
  /quedó al terminar/.test(js) && /lo que hay en la caja/.test(js));
comp('y la tarjeta lo explica entera: tenía, se movió, quedó',
  /Tenía al empezar/.test(js) && /Entró menos salió/.test(js) &&
  /Quedó al terminar/.test(js));
// Se SUMA, no se pide aparte: los tres números de la pantalla tienen que cuadrar
// entre ellos siempre. Y lo que se suma es la víspera, no el efectivo de hoy,
// que ya lleva el período dentro y contaría cada peso dos veces.
comp('lo que quedó se calcula sumando la víspera con lo que se movió',
  /const fin = m => ini\[m\] \+ quedo\(m\)/.test(js) &&
  /gaveta_inicio/.test(servidor) && /FROM fondo WHERE fecha < \?/.test(servidor));
// Y un período en negativo no se pinta de rojo: no es un fallo, es un día en el
// que salió más de lo que entró. El rojo de esta tarjeta está reservado para la
// caja en negativo, que sí es imposible, y gastarlo aquí le quita fuerza.
comp('un período negativo no se pinta de rojo; la caja en negativo sí',
  /quedo\('CUP'\) >= 0 && quedo\('USD'\) >= 0[\s\S]{0,60}var\(--texto2\)/.test(js) &&
  /const enRojo = g\.CUP < 0 \|\| g\.USD < 0/.test(js) &&
  /Esta caja está en /.test(js));
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
// Y dentro, cada renglón se abre para enseñar de qué está hecho: qué ventas
// fueron esos 166 USD, con sus productos y sus precios. Pedido el 29 de agosto
// de 2026, con la condición de que fuera opcional y no alargara la pantalla.
comp('cada renglón se puede abrir para ver los apuntes que lo suman',
  /<details class="renglon"/.test(js) && /ontoggle="abrirDesglose\(this\)"/.test(js) &&
  /\.renglon > summary\{/.test(css));
comp('viene cerrado, que abrir los ocho de cada tienda alargaría la pantalla',
  !/<details class="renglon"[^>]* open/.test(js));
comp('y se pide al abrir, una sola vez, no al cargar la pantalla',
  /if \(!d\.open \|\| d\.dataset\.hecho\) return;/.test(js));
comp('el servidor lo contesta con la MISMA condición con que suma el renglón',
  /const DESGLOSE = \{/.test(servidor) && /\/api\/negocio\/desglose/.test(servidor) &&
  /de_ventas:\s+"f\.tipo='ingreso' AND COALESCE\(f\.ref_tipo,''\)='venta'"/.test(servidor));
comp('una venta enseña sus productos, y un apunte anulado sale tachado',
  /class="prod"/.test(js) && /\.desgl \.muerto/.test(css));
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
const ajGente = (html.match(/id="aj-gente"[\s\S]*?fin de Personal/) || [''])[0];
comp('en Ajustes ya no queda la lista, solo el aviso de dónde está',
  !/id="lista-comisiones"/.test(ajGente) && /Dinero → Comisiones/.test(ajGente));
// Y TODO apunte a mano tiene que decir en qué caja pasa el dinero —desde el
// 31-ago-2026 también el ingreso—. Se comprueba en el servidor, que es quien
// manda; esconder la opción en la pantalla es decoración (#10).
comp('el servidor exige el sitio en TODO apunte a mano, ingreso incluido',
  /function sitioDelApunte/.test(servidor) &&
  /if \(!b\.sitio_id\) return b\.tipo === 'ingreso'/.test(servidor));
comp('y lo comprueba tanto al apuntar como al corregir',
  (servidor.match(/sitioDelApunte\(/g) || []).length >= 3);
// Se busca la OPCIÓN, no las palabras: el comentario que explica por qué se
// quitó las lleva dentro, y buscarlas sueltas daba por malo lo que está bien.
comp('la pantalla ya no ofrece «ninguno en concreto» en ningún tipo',
  !/<option value="">Ninguno en concreto<\/option>/i.test(js) &&
  /\$\('fo-sitio'\)\.innerHTML = '<option value="">Elige…<\/option>'/.test(js));
// Pero la lista de «de aquí sale dinero» NO puede llevar el ingreso: es la que
// comprueba que el dinero ESTÉ dentro (#38), y un ingreso no tiene que estar
// dentro de nada porque lo está metiendo. Mezclarlas prohibiría ingresar en una
// caja vacía, que es justo lo que hay que poder hacer.
comp('pero el ingreso NO entra en la comprobación de «hay dinero para sacarlo»',
  /SALE_DE_UNA_CAJA = \['retiro', 'gasto', 'inversion'\]/.test(servidor));
comp('y el rótulo dice si el dinero entra o sale de esa caja',
  /Entra en la caja de \*/.test(js) && /Sale de la caja de \*/.test(js));


console.log('\n=== Ni una palabra de programación en lo que lee el cliente ===');
// Pedido por el dueño el 3 de septiembre de 2026, con una foto de su teléfono:
// la pantalla de entrar le decía «abre la consola en la carpeta del proyecto y
// escribe npm start». Sus palabras: «por ningún motivo pueden salir mensajes que
// hagan referencia a nada de consola, ni npm start ni nada que tenga que ver con
// código o programación; eso me expone mi trabajo y hace que no parezca
// profesional».
//
// Un mensaje así no es solo feo: no le sirve de nada a quien lo lee —en un
// teléfono no hay ninguna consola que abrir— y enseña por dentro un trabajo que
// se entrega terminado.
//
// SE MIRAN LOS TEXTOS, NO EL CÓDIGO. En app.js se sacan los literales de texto,
// que es lo único que puede acabar en una pantalla; el código y los comentarios
// se quedan fuera, porque ahí estas palabras son normales y necesarias —hay una
// comprobación de direcciones que nombra «localhost» y está perfectamente—.
const JERGA = /\b(npm|consola|localhost|node_modules|package\.json|sqlite|stacktrace)\b/i;
const literales = t => (t.match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) || []);
const sinComentariosHTML = t => t.replace(/<!--[\s\S]*?-->/g, ' ');

const enJS = literales(js).filter(t => JERGA.test(t));
comp('en app.js no se le enseña jerga de programación a nadie', !enJS.length,
  enJS.slice(0, 3).join(' · ').slice(0, 200));
const enHTML = sinComentariosHTML(html).match(JERGA);
comp('en index.html no se le enseña jerga de programación a nadie', !enHTML,
  enHTML ? 'sale «' + enHTML[0] + '»' : '');
// Y la prueba no vale nada si no caza lo que tiene que cazar: se le da el
// mensaje de aquel día y tiene que saltar.
comp('y la comprobación caza el mensaje que salió en el teléfono',
  literales("throw new Error('Comprueba que está arrancado: escribe npm start en la consola.');")
    .some(t => JERGA.test(t)));

// LO DE DENTRO NO SE NOMBRA, Y LAS RUTAS MENOS. Ampliado el 4 de septiembre de
// 2026, con dos que se le colaron al dueño en la pantalla: Ajustes le enseñaba la
// carpeta del disco donde se guardan las copias, y una tarjeta que decía
// «Servidor: en marcha». Sus palabras: «eso es algo que me interesa a mí como
// programador y no a mi cliente; solo informarle a él de lo relacionado con su
// negocio».
//
// No es lo mismo que la jerga de arriba: estas palabras no son de programación,
// son de las TRIPAS. Quien usa la aplicación no puede hacer nada con ellas.
//
// Se saltan los literales que nunca se leen —direcciones, identificadores de la
// pantalla, tipos de archivo—, porque ahí «servidor» es parte de un nombre y está
// perfectamente.
const TRIPAS = /(servidor|nginx|pm2|backend|deploy)/i;
const RUTA = /(^|[\s"'(«])(\/root|\/etc|\/var|\/home|[A-Za-z]:\\)/;
const esCodigoYNoTexto = t => /^['"`][\/#.]|^['"`][a-z-]+\/[a-z+-]+['"`]$|^['"`][a-z][a-z0-9-]*['"`]$/i.test(t);
const sinComentariosJS = t => t.replace(/^\s*\/\/.*$/gm, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');

const tripasJS = literales(sinComentariosJS(js))
  .filter(t => !esCodigoYNoTexto(t) && (TRIPAS.test(t) || RUTA.test(t)));
comp('en app.js no se nombran las tripas ni ninguna carpeta del disco', !tripasJS.length,
  tripasJS.slice(0, 3).join(' · ').slice(0, 200));

// En el HTML se mira SOLO lo que queda entre etiquetas, que es lo que se lee: en
// un atributo puede haber una dirección con la palabra dentro y no la ve nadie.
const textosHTML = (sinComentariosHTML(html).match(/>[^<>]+</g) || []);
const tripasHTML = textosHTML.filter(t => TRIPAS.test(t) || RUTA.test(t));
comp('en index.html no se nombran las tripas ni ninguna carpeta del disco', !tripasHTML.length,
  tripasHTML.slice(0, 2).map(t => t.replace(/\s+/g, ' ').trim()).join(' · ').slice(0, 200));

// Y que el servidor no MANDE la carpeta de las copias, que es por donde entró:
// mientras viaje al aparato, cualquier día alguien vuelve a pintarla.
comp('la carpeta de las copias no sale del servidor', !/carpeta: RUTA_SALVAS/.test(servidor));


console.log('\n=== El almacén principal es el mirador, no un sitio ===');
// Pedido por el dueño el 4 de septiembre de 2026, después de desplegar la #45:
// «el almacén principal es solo para sumar lo de todos los almacenes, ahí no se
// asigna nada; ni en dinero ni en productos se mueve nada por él». Lo vio en el
// desplegable de «Este producto es de», que se lo ofrecía (#48).
comp('el mirador se reconoce por su identificador, no por ser el más viejo',
  /const MIRADOR = 'principal'/.test(js) &&
  /const esMirador = id => id === MIRADOR/.test(js) &&
  /const MIRADOR = 'principal'/.test(servidor) &&
  /const esMirador = id => String\(id \|\| ''\) === MIRADOR/.test(servidor));
comp('hay una lista de locales de verdad, sin él',
  /const sitiosReales = \(\) => SITIOS\.filter\(s => !esMirador\(s\.id\)\)/.test(js));
// La ficha del producto es donde lo vio.
comp('la ficha no ofrece el mirador como local',
  /\$\('f-sitio'\)\.innerHTML =[\s\S]{0,160}sitiosReales\(\)\.map/.test(js));
comp('y estando en él no propone ninguno: se queda «todavía sin local»',
  /\$\('f-sitio'\)\.value = p \? \(p\.sitio_id \|\| ''\)\s*:\s*\(enElMirador\(\) \? '' : sitioActual\(\)\)/.test(js));
// Y ningún otro desplegable de «dónde pasa esto» lo ofrece. Se cuentan los que
// quedan mirando SITIOS a pelo: los que quedan son los de mirar, no los de hacer.
const pickersCrudos = (js.match(/SITIOS\.map\(/g) || []).length;
comp('ningún desplegable de «dónde pasa esto» lo sigue ofreciendo',
  pickersCrudos === 1, pickersCrudos + ' quedan mirando SITIOS a pelo');
// En la caja no se vende desde ahí, y se dice antes de armar un carro que el
// servidor va a rechazar.
comp('en la caja se dice que ahí no se vende, y se apaga la caja',
  /id="caja-mirador"/.test(html) &&
  /const mirando = enElMirador\(\);/.test(js) &&
  /if \(mirando\) \{ cont\.innerHTML = ''; return; \}/.test(js));
// En el almacén, estando ahí, siempre la suma y ningún botón de mover nada.
comp('en el almacén se enseña siempre la suma, y sin botones',
  /if \(enElMirador\(\)\) \$\('alm-alcance'\)\.value = 'todos'/.test(js));
// Y el servidor lo niega, que es lo único que manda (#10).
comp('el servidor no deja escribir nada con el mirador puesto',
  /En ' \+ nombre \+ ' no se guarda nada/.test(servidor) &&
  /if \(req\.method === 'GET'\) return next\(\);/.test(servidor));
comp('y la migración devuelve a «sin local» lo que se le había dado',
  /mirador_no_es_un_sitio/.test(servidor) &&
  /UPDATE productos SET sitio_id=NULL WHERE sitio_id='principal'/.test(servidor));

// DE QUÉ LOCAL ES CADA PRODUCTO, EN LA PROPIA FILA. «Debe decir claramente por
// algún lado a dónde está asignado el producto», dijo el mismo día.
comp('cada producto dice de qué local es, en su fila y con su color',
  /class="donde\$\{p\.sitio_id \? '' : ' sinLocal'\}"/.test(js) &&
  /\.prod \.sub \.donde\{/.test(css) && /\.prod \.sub \.donde\.sinLocal\{/.test(css));
comp('y el que no tiene ninguno lo dice también',
  /const donde = !p\.sitio_id \? 'Todavía sin local'/.test(js));

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

// Al crear un producto no había dónde poner lo que ya se tiene en el estante:
// la existencia solo entraba por el botón «Entrada». La casilla que se añadió
// NO puede convertirse en un campo guardado, o se rompe la decisión #1 y vuelve
// el inventario que desaparece cuando dos aparatos se pisan.
console.log('\n=== La existencia con la que nace un producto ===');
comp('la ficha tiene la casilla, y su explicación',
  /id="f-existencia-caja"/.test(html) && /id="f-existencia"/.test(html) &&
  /id="f-existencia-pista"/.test(html));
comp('solo se pregunta al crear, no al editar',
  /const puedeExistencia = fichaNaciendo && puedo\('gestionar_inventario'\)/.test(js) &&
  /\$\('f-existencia-caja'\)\.style\.display = puedeExistencia \? 'block' : 'none'/.test(js));
// Quien solo lleva el catálogo no puede mover mercancía: si viera la casilla,
// crearía el producto y el servidor le rechazaría la entrada después.
comp('y solo a quien puede mover mercancía',
  /puedeExistencia = fichaNaciendo && puedo\('gestionar_inventario'\)/.test(js));
// Y SOLO SI EL PRODUCTO TIENE LOCAL (#45): la mercancía tiene que estar en algún
// sitio, y uno que se deja «todavía sin local» no tiene dónde meterla.
comp('y solo si el producto tiene local, porque si no no hay dónde meterla',
  /puedeExistencia = fichaNaciendo && puedo\('gestionar_inventario'\) && !!donde/.test(js));
// La entrada va al local DEL PRODUCTO, no al que se esté mirando: desde el almacén
// principal se crean cosas que son de una tienda, y meterlas en el almacén las
// dejaría contadas donde no están.
comp('se apunta como ENTRADA de verdad, en el local del producto',
  /api\('\/api\/movimientos'[\s\S]{0,200}tipo: 'compra'[\s\S]{0,120}sitio_id: sitioId/.test(js) &&
  /apuntarExistenciaInicial\(r\.id, cuerpo\.costo, existencia,\s*localDeLaFicha\(\)\)/.test(js));
// El cuerpo que viaja a /api/productos es el que no puede llevarla: guardarla
// ahí sería el campo «este punto tiene 47 unidades» que la #1 prohíbe.
comp('NO viaja dentro del producto: el stock se sigue calculando',
  !/(existencia|stock)\s*[:,]/.test(js.slice(js.indexOf('const cuerpo = {'),
                                              js.indexOf("precios: [...document.querySelectorAll('#ficha-precios input')]"))));
comp('vacío no apunta nada, y cero se devuelve por despiste',
  /function existenciaEscrita[\s\S]{0,400}if \(txt === ''\) return null/.test(js) &&
  /existencia !== null && !\(existencia > 0\)/.test(js));
// El producto se crea primero y la entrada después: si la segunda falla —la
// jornada cerrada, o el internet— el producto YA existe. Callarlo dejaría el
// inventario diciendo cero con la mercancía en el estante.
comp('si la entrada falla se dice, con el producto ya creado',
  /catch \(e\) \{[\s\S]{0,200}mal: true[\s\S]{0,200}NO se pudo apuntar/.test(js) &&
  /id="nc-aviso"/.test(html) &&
  /av\.style\.color = aviso\.mal \? 'var\(--rojo\)'/.test(js));
comp('y la cantidad se mira ANTES de crear nada',
  js.indexOf('const existencia = existenciaEscrita()') <
  js.indexOf("await api('/api/productos', { method: 'POST'"));

console.log('\n' + (mal ? 'FALLAN ' + mal + ' de ' + (ok + mal) : 'TODO BIEN: ' + ok + ' comprobaciones'));
process.exit(mal ? 1 : 0);
