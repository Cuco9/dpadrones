// Los permisos: uno para cada cosa, atados al sitio, y el jefe metiéndose en la
// piel de un trabajador para írselos dando.
//
// Pedido por el dueño el 17 de agosto de 2026: «un trabajador de la tienda solo
// tendrá permisos permitidos dentro de esa tienda, no podrá tocar más nada que sea
// de otro sitio», «necesito permisos para todo lo que existe en la aplicación», y
// «el admin tiene la opción de ver la aplicación como lo haría ese trabajador con
// su rol y sus permisos y puede hacer lo mismo que él, porque no tengo claro lo que
// quiero que haga cada trabajador».
//
// Lo que se comprueba aquí es lo que puede salir mal SIN QUE SE NOTE, que es todo
// en materia de permisos: una puerta abierta no avisa de que está abierta.
//
//   · que el sitio se comprueba en el SERVIDOR y no escondiendo botones: la prueba
//     manda el sitio ajeno a mano, que es lo que haría cualquiera;
//   · que el amarre al sitio vale para leer y para escribir, y también para los
//     dos sitios que van dentro de una línea: de dónde sale el material y a
//     dónde va cada unidad al repartir una inversión;
//   · que los cargos que llegan con los permisos VIEJOS se traducen en vez de
//     quedarse vacíos, porque un teléfono con el app.js viejo en su caché los manda
//     así y dejaría a esa gente fuera de la aplicación;
//   · que hacerse pasar por otro da los permisos DEL OTRO y no los de administrador;
//   · que lo apuntado en la piel de otro queda a nombre de quien firma;
//   · y que al chocar con una puerta cerrada se dice QUÉ permiso falta, que es lo
//     que hace posible dárselo en el momento.
//
//   node pruebas/permisos.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const raiz = path.join(__dirname, '..');
const patio = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-perm-'));

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
function arrancar(env, listo) {
  const p = spawn(process.execPath, ['server.js'], {
    cwd: raiz, env: Object.assign({}, process.env, env), stdio: ['ignore', 'pipe', 'pipe'] });
  procesos.push(p);
  let salida = '';
  return new Promise((res, rej) => {
    const mirar = d => { salida += d; if (listo.test(salida)) res(salida); };
    p.stdout.on('data', mirar);
    p.stderr.on('data', mirar);
    p.on('exit', c => rej(new Error('server.js se murió (' + c + '):\n' + salida)));
    setTimeout(() => rej(new Error('server.js no arrancó a tiempo:\n' + salida)), 60000);
  });
}
const cerrarTodo = () => procesos.forEach(p => { try { p.kill(); } catch (e) {} });

let BASE, cab;
async function pedir(ruta, opciones = {}) {
  const conf = Object.assign({}, opciones);
  conf.headers = Object.assign({ 'Content-Type': 'application/json' },
    cab || {}, opciones.headers || {});
  const r = await fetch(BASE + ruta, conf);
  return { status: r.status, cuerpo: await r.json().catch(() => ({})) };
}
const post = (ruta, cuerpo) => pedir(ruta, { method: 'POST', body: JSON.stringify(cuerpo || {}) });
const como = t => ({ Authorization: 'Bearer ' + t });
const postComo = (t, ruta, cuerpo) => pedir(ruta,
  { method: 'POST', body: JSON.stringify(cuerpo || {}), headers: como(t) });
const getComo = (t, ruta) => pedir(ruta, { headers: como(t) });
const hoy = new Date().toLocaleDateString('sv-SE');

(async () => {
  try {
    const PUERTO = await puertoLibre();
    BASE = 'http://127.0.0.1:' + PUERTO;
    await arrancar({ PUERTO, DP_DB: path.join(patio, 'app.db'), DP_HTTP: '1' },
                   /D´Padrones/);

    console.log('\n=== El catálogo de permisos ===');
    await post('/api/auth/crear-admin', { nombre: 'Jefe', usuario: 'jefe', pin: '1234' });
    const ses = await post('/api/auth/entrar', { usuario: 'jefe', pin: '1234' });
    cab = { Authorization: 'Bearer ' + ses.cuerpo.token };
    const estado = await pedir('/api/auth/estado');
    const cat = estado.cuerpo.permisos_posibles || [];
    comp('hay bastantes más de los quince de antes', cat.length >= 25, cat.length);
    comp('cada uno dice a qué área pertenece, para poder leerlos',
      cat.every(p => p.area), JSON.stringify(cat.filter(p => !p.area).map(p => p.id)));
    comp('hay permisos separados para VER y para HACER en el dinero',
      cat.some(p => p.id === 'ver_fondo') && cat.some(p => p.id === 'mover_dinero') &&
      cat.some(p => p.id === 'corregir_dinero'));
    comp('cerrar la jornada y reabrirla son permisos distintos',
      cat.some(p => p.id === 'cerrar_dia') && cat.some(p => p.id === 'reabrir_dia'));
    comp('el valor del dólar NO está en la lista: es solo del administrador',
      !cat.some(p => /tasa|moneda_base/.test(p.id)));

    const almacen = (await pedir('/api/sitios')).cuerpo[0].id;
    const tienda = (await post('/api/sitios',
      { nombre: 'Tienda Centro', tipo: 'punto', padre_id: almacen })).cuerpo.id;
    const prod = (await post('/api/productos', { nombre: 'Cable', precio: 100,
      precio_moneda: 'CUP', costo: 60, comision: 10, um: 'Metro' })).cuerpo.id;
    await post('/api/movimientos', { tipo: 'compra', sitio_id: tienda, producto_id: prod,
      cantidad: 100, costo_unit: 60 });
    await post('/api/movimientos', { tipo: 'compra', sitio_id: almacen, producto_id: prod,
      cantidad: 100, costo_unit: 60 });

    console.log('\n=== Lo que llega con los nombres VIEJOS se traduce ===');
    // Un dispositivo con el app.js viejo guardado en su caché manda los de antes.
    // Filtrarlos a secas dejaría el cargo SIN NINGÚN permiso, y a esa gente fuera
    // de la aplicación por haber tocado «Guardar».
    const viejo = await post('/api/cargos', { nombre: 'Del teléfono viejo',
      permisos: ['vender', 'gestionar_dinero'] });
    const cargosAhora = (await pedir('/api/cargos')).cuerpo.cargos;
    const traducido = cargosAhora.find(c => c.id === viejo.cuerpo.id).permisos.split(',');
    comp('«vender» sigue dejando vender', traducido.includes('vender'));
    comp('y trae consigo ver el catálogo, que sin eso no se puede vender',
      traducido.includes('ver_catalogo'));
    comp('«gestionar_dinero» se abre en sus partes',
      ['ver_fondo', 'mover_dinero', 'corregir_dinero', 'traspasos']
        .every(p => traducido.includes(p)), traducido.join(','));
    comp('y no se cuela ninguno inventado',
      traducido.every(p => cat.some(x => x.id === p)), traducido.join(','));

    console.log('\n=== Quitar un permiso que otro necesita ===');
    // Pasó de verdad el 17 de agosto, con el catálogo nuevo recién desplegado: el
    // dueño quitaba «Ver costos y ganancias» del cargo de marketing, guardaba, y
    // seguía ahí. Volvía solo porque «Repasar y corregir costos» lo necesita —no se
    // puede corregir un costo sin ver los costos— y la aplicación no lo decía.
    const conCostos = await post('/api/cargos', { nombre: 'Marketing',
      permisos: ['corregir_costos'] });
    const guardados = (await pedir('/api/cargos')).cuerpo.cargos
      .find(c => c.id === conCostos.cuerpo.id).permisos.split(',');
    comp('marcar «corregir costos» enciende «ver ganancias»',
      guardados.includes('ver_ganancias'), guardados.join(','));
    comp('y el servidor DEVUELVE lo que quedó, no lo que se pidió',
      (conCostos.cuerpo.permisos || []).includes('ver_ganancias'),
      JSON.stringify(conCostos.cuerpo.permisos));
    // Es lo que deja a la pantalla comparar y avisar en vez de dejar creer que no
    // se guardó. Y quitando los dos, se va de verdad.
    const sinNada = await post('/api/cargos', { id: conCostos.cuerpo.id,
      nombre: 'Marketing', permisos: ['web_escribir'] });
    comp('quitando los dos, «ver ganancias» se va',
      !(sinNada.cuerpo.permisos || []).includes('ver_ganancias'),
      JSON.stringify(sinNada.cuerpo.permisos));

    console.log('\n=== Cada uno en su sitio ===');
    const vende = (await post('/api/cargos', { nombre: 'Vendedora',
      permisos: ['vender', 'ver_ventas', 'gestionar_inventario', 'cerrar_dia'] })).cuerpo.id;
    // Ana trabaja EN LA TIENDA. Luis no tiene sitio: puede en todos.
    await post('/api/personas', { nombre: 'Ana', usuario: 'ana', pin: '1111',
      cargo_id: vende, sitio_id: tienda });
    await post('/api/personas', { nombre: 'Luis', usuario: 'luis', pin: '2222',
      cargo_id: vende });
    const tAna = (await post('/api/auth/entrar', { usuario: 'ana', pin: '1111' })).cuerpo.token;
    const tLuis = (await post('/api/auth/entrar', { usuario: 'luis', pin: '2222' })).cuerpo.token;

    const suSitio = await postComo(tAna, '/api/ventas', { sitio_id: tienda, moneda: 'CUP',
      lineas: [{ producto_id: prod, cantidad: 1 }] });
    comp('en su tienda vende sin problema', suSitio.status === 200,
      suSitio.status + ' ' + JSON.stringify(suSitio.cuerpo).slice(0, 120));
    // Y AQUÍ está lo que antes no se comprobaba: el sitio viaja en la petición, así
    // que bastaba con cambiarlo. La pantalla solo enseñaba su tienda, pero eso es
    // decoración (DECISIONES.md #10).
    const ajeno = await postComo(tAna, '/api/ventas', { sitio_id: almacen, moneda: 'CUP',
      lineas: [{ producto_id: prod, cantidad: 1 }] });
    comp('vender en el almacén, que no es su sitio, se le niega', ajeno.status === 403,
      ajeno.status + ' ' + JSON.stringify(ajeno.cuerpo).slice(0, 120));
    comp('y se le dice en qué sitio trabaja y cuál está tocando',
      /Tienda Centro/.test(ajeno.cuerpo.error || '') &&
      /Almacén Principal/.test(ajeno.cuerpo.error || ''), ajeno.cuerpo.error);
    comp('apuntar una merma en otro sitio, tampoco',
      (await postComo(tAna, '/api/movimientos', { tipo: 'merma', sitio_id: almacen,
        producto_id: prod, cantidad: 5 })).status === 403);
    comp('cerrar la jornada de otro sitio, tampoco',
      (await postComo(tAna, '/api/dias/cerrar', { sitio_id: almacen, fecha: hoy,
        efectivo: 0 })).status === 403);
    comp('ni mirar el inventario de otro sitio',
      (await getComo(tAna, '/api/stock?sitio_id=' + almacen)).status === 403);
    comp('el suyo sí lo mira', (await getComo(tAna, '/api/stock?sitio_id=' + tienda)).status === 200);
    comp('y quien no tiene sitio propio puede en el almacén',
      (await postComo(tLuis, '/api/ventas', { sitio_id: almacen, moneda: 'CUP',
        lineas: [{ producto_id: prod, cantidad: 1 }] })).status === 200);

    console.log('\n=== Un cargo con permiso en VARIOS locales ===');
    // Preguntado por el dueño: «¿se puede crear un rol que sí tenga permiso en
    // varias tiendas y almacenes?». El alcance va en el cargo; el local de cada
    // persona, en su ficha. Con «solo su local», un mismo cargo sirve para todas
    // las tiendas sin duplicarlo.
    const dosLocales = (await post('/api/cargos', { nombre: 'Encargado de zona',
      permisos: ['vender', 'ver_ventas'], alcance: 'lista',
      sitios: [tienda, almacen] })).cuerpo;
    comp('el cargo guarda que vale en dos locales', dosLocales.alcance === 'lista' &&
      (dosLocales.sitios || '').split(',').length === 2, JSON.stringify(dosLocales));
    await post('/api/personas', { nombre: 'Zoe', usuario: 'zoe', pin: '4444',
      cargo_id: dosLocales.id, sitio_id: tienda });
    const tZoe = (await post('/api/auth/entrar', { usuario: 'zoe', pin: '4444' })).cuerpo.token;
    comp('Zoe vende en su tienda',
      (await postComo(tZoe, '/api/ventas', { sitio_id: tienda, moneda: 'CUP',
        lineas: [{ producto_id: prod, cantidad: 1 }] })).status === 200);
    // Lo que Ana NO puede y Zoe sí, con los mismos permisos: la diferencia está en
    // el alcance del cargo, no en la lista de permisos.
    comp('y también en el almacén, porque su cargo lo incluye',
      (await postComo(tZoe, '/api/ventas', { sitio_id: almacen, moneda: 'CUP',
        lineas: [{ producto_id: prod, cantidad: 1 }] })).status === 200);

    const otroPunto = (await post('/api/sitios',
      { nombre: 'Tienda Vedado', tipo: 'punto', padre_id: almacen })).cuerpo.id;
    await post('/api/movimientos', { tipo: 'compra', sitio_id: otroPunto, producto_id: prod,
      cantidad: 10, costo_unit: 60 });
    comp('pero en un tercer local que no está en la lista, no',
      (await postComo(tZoe, '/api/ventas', { sitio_id: otroPunto, moneda: 'CUP',
        lineas: [{ producto_id: prod, cantidad: 1 }] })).status === 403);

    // Y el cargo «todos los locales», que es el del encargado general.
    const todos = (await post('/api/cargos', { nombre: 'Dirección de tiendas',
      permisos: ['vender', 'ver_ventas'], alcance: 'todos' })).cuerpo;
    await post('/api/personas', { nombre: 'Rita', usuario: 'rita', pin: '6666',
      cargo_id: todos.id, sitio_id: tienda });
    const tRita = (await post('/api/auth/entrar', { usuario: 'rita', pin: '6666' })).cuerpo.token;
    comp('con alcance «todos», vende en cualquier local aunque tenga uno puesto',
      (await postComo(tRita, '/api/ventas', { sitio_id: otroPunto, moneda: 'CUP',
        lineas: [{ producto_id: prod, cantidad: 1 }] })).status === 200);

    // Un cargo marcado «estos locales» y sin ninguno marcado no vale en ninguno.
    // Lo contrario —valer en todos— sería justo lo que se quiso evitar al elegir esa
    // opción, y nadie lo notaría hasta que alguien tocara la tienda de al lado.
    const ninguno = (await post('/api/cargos', { nombre: 'A medio configurar',
      permisos: ['vender'], alcance: 'lista', sitios: [] })).cuerpo;
    await post('/api/personas', { nombre: 'Iván', usuario: 'ivan', pin: '1212',
      cargo_id: ninguno.id, sitio_id: tienda });
    const tIvan = (await post('/api/auth/entrar', { usuario: 'ivan', pin: '1212' })).cuerpo.token;
    comp('«estos locales» sin ninguno marcado no abre ninguno, ni el suyo',
      (await postComo(tIvan, '/api/ventas', { sitio_id: tienda, moneda: 'CUP',
        lineas: [{ producto_id: prod, cantidad: 1 }] })).status === 403);

    console.log('\n=== El sitio de dentro de una línea también se mira ===');
    // El sitio de arriba no es el único que viaja: dentro de cada línea va otro,
    // y esa es la puerta de atrás. En una inversión hay DOS sitios por línea —de
    // dónde sale el material y a dónde va cada unidad— y los dos hay que mirarlos.
    //
    // Sin la segunda comprobación, quien solo manda en la tienda podía registrar
    // una inversión y mandar la mercancía al almacén: existencias metidas en un
    // sitio del que no responde, y sin el traslado que el otro lado confirma.
    const compradora = (await post('/api/cargos', { nombre: 'Encargada tienda',
      permisos: ['gestionar_inversiones', 'ver_inversiones', 'ver_catalogo'] })).cuerpo.id;
    await post('/api/personas', { nombre: 'Marta', usuario: 'marta', pin: '3333',
      cargo_id: compradora, sitio_id: tienda });
    const tMarta = (await post('/api/auth/entrar', { usuario: 'marta', pin: '3333' })).cuerpo.token;

    // La caja de donde sale el dinero es la SUYA; lo que se cuela es el reparto.
    const porElReparto = await postComo(tMarta, '/api/inversiones', {
      nombre: 'Con truco', moneda: 'CUP', sitio_id: tienda,
      lineas: [{ producto_id: prod, cantidad: 10, costo_unit: 60,
                 reparto: [{ sitio_id: almacen, cantidad: 10 }] }] });
    comp('repartir la mercancía de una inversión hacia otro sitio se niega',
      porElReparto.status === 403,
      porElReparto.status + ' ' + JSON.stringify(porElReparto.cuerpo).slice(0, 140));
    comp('y se le dice qué sitio está tocando y qué hacer en su lugar',
      /Almacén Principal/.test(porElReparto.cuerpo.error || '') &&
      /despáchala/i.test(porElReparto.cuerpo.error || ''), porElReparto.cuerpo.error);

    // La otra forma de la misma puerta: el sitio suelto de la línea.
    comp('y una línea que saca material de otro sitio, tampoco',
      (await postComo(tMarta, '/api/inversiones', { nombre: 'El otro truco',
        moneda: 'CUP', sitio_id: tienda,
        lineas: [{ producto_id: prod, cantidad: 10, costo_unit: 60,
                   sitio_id: almacen }] })).status === 403);

    // Y lo que SÍ puede hacer, que es la mitad que importa: si esto también se
    // negara, el gancho estaría cerrado a costa de dejarla sin trabajar.
    const suya = await postComo(tMarta, '/api/inversiones', {
      nombre: 'Sin truco', moneda: 'CUP', sitio_id: tienda,
      lineas: [{ producto_id: prod, cantidad: 10, costo_unit: 60,
                 reparto: [{ sitio_id: tienda, cantidad: 10 }] }] });
    comp('repartirla en su propia tienda entra sin problema', suya.status === 200,
      suya.status + ' ' + JSON.stringify(suya.cuerpo).slice(0, 140));

    console.log('\n=== Ver todos los sitios: mirar sí, tocar no ===');
    const mirona = (await post('/api/cargos', { nombre: 'Supervisora',
      permisos: ['ver_negocio_entero', 'ver_catalogo', 'vender'] })).cuerpo.id;
    await post('/api/personas', { nombre: 'Sara', usuario: 'sara', pin: '5555',
      cargo_id: mirona, sitio_id: tienda });
    const tSara = (await post('/api/auth/entrar', { usuario: 'sara', pin: '5555' })).cuerpo.token;
    comp('con «ver todos los sitios» puede mirar el inventario del almacén',
      (await getComo(tSara, '/api/stock?sitio_id=' + almacen)).status === 200);
    comp('pero seguir sin poder vender allí',
      (await postComo(tSara, '/api/ventas', { sitio_id: almacen, moneda: 'CUP',
        lineas: [{ producto_id: prod, cantidad: 1 }] })).status === 403);

    console.log('\n=== El encargado de una tienda ve el dinero DE SU TIENDA ===');
    // Pedido por el dueño el 21 de agosto de 2026 (DECISIONES.md #39): «tengo un
    // trabajador que quiero que vea el fondo de la tienda que le asigné, pero con
    // los permisos para esa tienda no ve el fondo; y cuando le marco "ver todos
    // los sitios" ve el fondo de toda la empresa».
    //
    // Era todo o nada por dos motivos a la vez: /api/negocio exigía «ver todos los
    // sitios» y la pantalla de Dinero lo pide junto con el fondo, así que sin ese
    // permiso se quedaba en blanco entera; y con él, ni el fondo ni el negocio
    // filtraban nada.
    await post('/api/fondo', { tipo: 'ingreso', subtipo: 'Aporte de socio', moneda: 'CUP',
      importe: 40000, sitio_id: tienda, concepto: 'Dinero de la tienda' });
    await post('/api/fondo', { tipo: 'ingreso', subtipo: 'Aporte de socio', moneda: 'CUP',
      importe: 900000, sitio_id: almacen, concepto: 'Dinero del almacén' });
    await post('/api/fondo', { tipo: 'ingreso', subtipo: 'Aporte de socio', moneda: 'CUP',
      importe: 7000, concepto: 'Aporte sin pasar por ninguna tienda' });

    const encargada = (await post('/api/cargos', { nombre: 'Encargada de tienda',
      permisos: ['ver_fondo', 'ver_informes', 'ver_ventas', 'vender'] })).cuerpo.id;
    await post('/api/personas', { nombre: 'Rosa', usuario: 'rosa', pin: '6666',
      cargo_id: encargada, sitio_id: tienda });
    const tRosa = (await post('/api/auth/entrar', { usuario: 'rosa', pin: '6666' })).cuerpo.token;

    const suFondo = await getComo(tRosa, '/api/fondo');
    comp('con «ver la caja» y su tienda, el fondo SE ABRE', suFondo.status === 200,
      suFondo.status + ' ' + JSON.stringify(suFondo.cuerpo).slice(0, 120));
    comp('y viene marcado que no es el negocio entero', suFondo.cuerpo.ver_todo === false,
      suFondo.cuerpo.ver_todo);
    comp('solo la gaveta de su tienda, ninguna más',
      (suFondo.cuerpo.gavetas || []).length === 1 &&
      suFondo.cuerpo.gavetas[0].sitio_id === tienda,
      JSON.stringify((suFondo.cuerpo.gavetas || []).map(g => g.sitio)));
    comp('el «saldo» que se le enseña es el de su caja, no el del negocio',
      suFondo.cuerpo.saldo.CUP === suFondo.cuerpo.gavetas[0].CUP,
      JSON.stringify({ saldo: suFondo.cuerpo.saldo.CUP, gaveta: suFondo.cuerpo.gavetas[0].CUP }));
    comp('y no lleva dentro el dinero del almacén',
      suFondo.cuerpo.saldo.CUP < 900000, suFondo.cuerpo.saldo.CUP);
    comp('en la lista no hay ni un apunte de otro sitio',
      (suFondo.cuerpo.movimientos || []).every(m => m.sitio_id === tienda),
      JSON.stringify((suFondo.cuerpo.movimientos || [])
        .filter(m => m.sitio_id !== tienda).map(m => m.concepto)));
    comp('tampoco los que no son de ningún sitio, que son del negocio',
      !(suFondo.cuerpo.movimientos || []).some(m => !m.sitio_id));

    const suNegocio = await getComo(tRosa, '/api/negocio');
    comp('el desglose por sitio también se le abre', suNegocio.status === 200,
      suNegocio.status + ' ' + JSON.stringify(suNegocio.cuerpo).slice(0, 120));
    comp('y trae una sola fila: la suya',
      (suNegocio.cuerpo.sitios || []).length === 1 &&
      suNegocio.cuerpo.sitios[0].sitio_id === tienda,
      JSON.stringify((suNegocio.cuerpo.sitios || []).map(p => p.sitio)));
    // El total es la suma de las filas que se enseñan (#22). Si se filtraran las
    // filas y el total se dejara entero, la pantalla enseñaría una tabla en la que
    // las cuentas no cuadran, que es peor que no enseñar nada.
    comp('y el total es el de esa fila, no el del negocio con una fila escondida',
      suNegocio.cuerpo.total.gaveta.CUP === suNegocio.cuerpo.sitios[0].gaveta.CUP,
      JSON.stringify({ total: suNegocio.cuerpo.total.gaveta,
                       fila: suNegocio.cuerpo.sitios[0].gaveta }));
    // Y el dinero de cada fila lo abre 'ver_fondo'. Lo abría 'gestionar_dinero',
    // que dejó de existir al partir los permisos (#35): desde entonces, quien no
    // tuviera además 'ver_ganancias' recibía todas las gavetas en blanco.
    comp('con «ver la caja» le llegan las cifras de la gaveta, no en blanco',
      suNegocio.cuerpo.ver_dinero === true && suNegocio.cuerpo.sitios[0].gaveta !== null,
      JSON.stringify(suNegocio.cuerpo.sitios[0].gaveta));

    const suResumen = await getComo(tRosa, '/api/resumen');
    comp('el resumen del período, sin pedir sitio, es el de su tienda',
      suResumen.status === 200 && suResumen.cuerpo.sitio === 'Tienda Centro',
      suResumen.status + ' ' + suResumen.cuerpo.sitio);
    comp('y se le dice que no está viendo el negocio entero',
      suResumen.cuerpo.ver_todo === false, suResumen.cuerpo.ver_todo);

    // Y al darle «Ver TODOS los sitios», que es justo lo que hace ese permiso,
    // pasa a verlo todo. Antes era la única forma de que viera algo.
    await post('/api/cargos/' + encargada + '/permiso', { permiso: 'ver_negocio_entero' });
    const conTodo = await getComo(tRosa, '/api/fondo');
    comp('con «ver todos los sitios» sí ve las demás cajas',
      conTodo.cuerpo.ver_todo === true && (conTodo.cuerpo.gavetas || []).length > 1,
      JSON.stringify((conTodo.cuerpo.gavetas || []).map(g => g.sitio)));
    comp('y entonces el saldo sí es el de toda la empresa',
      conTodo.cuerpo.saldo.CUP > 900000, conTodo.cuerpo.saldo.CUP);
    comp('la aplicación le dice en qué locales se mueve, para no ofrecerle otros',
      Array.isArray((await getComo(tAna, '/api/auth/yo')).cuerpo.mis_sitios) &&
      (await getComo(tRosa, '/api/auth/yo')).cuerpo.mis_sitios === null,
      JSON.stringify((await getComo(tAna, '/api/auth/yo')).cuerpo.mis_sitios));
    // Y ya al entrar, que es de donde lo lee la pantalla: pedirlo otra vez sería
    // una petición más antes de ver nada, y el día que fallara el desplegable
    // saldría con todos los sitios como si no hubiera límite ninguno.
    const alEntrar = (await post('/api/auth/entrar', { usuario: 'ana', pin: '1111' })).cuerpo;
    comp('y ya viene en la respuesta de entrar, no hay que pedirlo aparte',
      Array.isArray(alEntrar.mis_sitios) && alEntrar.mis_sitios.length === 1 &&
      alEntrar.mis_sitios[0] === tienda, JSON.stringify(alEntrar.mis_sitios));

    console.log('\n=== Cada permiso guarda lo suyo ===');
    comp('sin «ver_fondo» no se ve la caja',
      (await getComo(tAna, '/api/fondo')).status === 403);
    comp('sin «reabrir_dia» no se reabre una jornada',
      (await postComo(tAna, '/api/dias/reabrir', { sitio_id: tienda, fecha: hoy })).status === 403);
    comp('sin «ver_informes» no se ve el resumen del período',
      (await getComo(tAna, '/api/resumen')).status === 403);
    comp('sin «ver_comisiones» no se ven las comisiones',
      (await getComo(tAna, '/api/comisiones')).status === 403);
    comp('sin «gestionar_personas» no se ve la lista de personal',
      (await getComo(tAna, '/api/cargos')).status === 403);
    comp('y el valor del dólar sigue siendo solo del administrador',
      (await postComo(tAna, '/api/tasa', { tasa: 999 })).status === 403);
    comp('lo que sí puede: vender y ver sus ventas',
      (await getComo(tAna, '/api/ventas?sitio_id=' + tienda + '&fecha=' + hoy)).status === 200);

    console.log('\n=== El 403 dice QUÉ permiso falta ===');
    const negado = await getComo(tAna, '/api/resumen');
    comp('viene el identificador del permiso, para poder darlo',
      (negado.cuerpo.falta || []).some(f => f.id === 'ver_informes'),
      JSON.stringify(negado.cuerpo));
    comp('y su nombre en claro, que es lo que se lee en la pantalla',
      /Ver el resumen del período/.test(negado.cuerpo.error || ''), negado.cuerpo.error);
    comp('y de qué cargo se está hablando', !!negado.cuerpo.de_cargo);

    console.log('\n=== El jefe se hace pasar por Ana ===');
    const noPuede = await postComo(tAna, '/api/auth/como', { persona_id: 'x' });
    comp('un trabajador no puede hacerse pasar por nadie', noPuede.status === 403,
      noPuede.status);
    const ana = (await pedir('/api/cargos')).cuerpo.personas.find(p => p.usuario === 'ana');
    const entrar = await post('/api/auth/como', { persona_id: ana.id });
    comp('el jefe sí puede', entrar.status === 200, JSON.stringify(entrar.cuerpo));
    const yo = await pedir('/api/auth/yo');
    comp('la aplicación dice que se está en la piel de Ana',
      yo.cuerpo.como && yo.cuerpo.como.nombre === 'Ana', JSON.stringify(yo.cuerpo.como));
    comp('y quién firma de verdad sigue estando a la vista',
      yo.cuerpo.yo_de_verdad && yo.cuerpo.yo_de_verdad.nombre === 'Jefe',
      JSON.stringify(yo.cuerpo.yo_de_verdad));
    // Lo que importa: los permisos son los de ELLA, no los de administrador.
    comp('los permisos pasan a ser los de Ana', !yo.cuerpo.permisos.includes('*'),
      JSON.stringify(yo.cuerpo.permisos).slice(0, 120));
    comp('así que el resumen del período se le niega AL JEFE mientras es Ana',
      (await pedir('/api/resumen')).status === 403);
    comp('y tampoco puede tocar el almacén, porque Ana es de la tienda',
      (await post('/api/ventas', { sitio_id: almacen, moneda: 'CUP',
        lineas: [{ producto_id: prod, cantidad: 1 }] })).status === 403);
    comp('el valor del dólar tampoco, aunque de verdad sea el administrador',
      (await post('/api/tasa', { tasa: 999 })).status === 403);

    console.log('\n=== Lo que hace en esa piel queda a SU nombre ===');
    const venta = await post('/api/ventas', { sitio_id: tienda, moneda: 'CUP',
      lineas: [{ producto_id: prod, cantidad: 3 }] });
    comp('puede vender, porque Ana puede', venta.status === 200,
      JSON.stringify(venta.cuerpo).slice(0, 120));
    const ficha = await pedir('/api/ventas/' + venta.cuerpo.id);
    comp('la venta NO queda a nombre de Ana', ficha.cuerpo.venta.persona_id !== ana.id,
      ficha.cuerpo.venta.persona_id + ' vs ana ' + ana.id);

    console.log('\n=== Se le da el permiso que le faltaba, sin salir de ahí ===');
    // Esta es la pieza que el dueño pidió para poder ir armando los permisos con la
    // pantalla delante: chocar, ver el nombre, dárselo y seguir.
    const dar = await post('/api/cargos/' + vende + '/permiso', { permiso: 'ver_informes' });
    comp('estando en la piel de Ana, el jefe puede dárselo a su cargo',
      dar.status === 200, JSON.stringify(dar.cuerpo));
    comp('y se dice a cuánta gente afecta, porque es del CARGO',
      dar.cuerpo.personas >= 1, dar.cuerpo.personas);
    comp('ahora la puerta se abre', (await pedir('/api/resumen')).status === 200);
    const quitar = await post('/api/cargos/' + vende + '/permiso',
      { permiso: 'ver_informes', quitar: true });
    comp('y se puede quitar igual de fácil', quitar.status === 200);
    comp('la puerta se cierra otra vez', (await pedir('/api/resumen')).status === 403);

    console.log('\n=== Volver a ser uno mismo ===');
    const salir = await post('/api/auth/como', {});
    comp('se sale de la piel', salir.status === 200 && salir.cuerpo.como === null,
      JSON.stringify(salir.cuerpo));
    const yo2 = await pedir('/api/auth/yo');
    comp('y vuelven los permisos de administrador', yo2.cuerpo.permisos.includes('*'),
      JSON.stringify(yo2.cuerpo.permisos));
    comp('el resumen vuelve a abrirse', (await pedir('/api/resumen')).status === 200);
    // Y la venta que hizo mientras era Ana quedó a nombre del jefe, con constancia
    // de en qué piel estaba. El registro no puede mentir sobre quién hizo qué.
    const personas = (await pedir('/api/cargos')).cuerpo.personas;
    const elJefe = personas.find(p => p.usuario === 'jefe');
    const laVenta = await pedir('/api/ventas/' + venta.cuerpo.id);
    comp('la venta quedó a nombre del jefe, que es quien la hizo',
      laVenta.cuerpo.venta.persona_id === elJefe.id,
      laVenta.cuerpo.venta.persona_id + ' vs jefe ' + elJefe.id);

    console.log('\n=== No se puede entrar en la piel de otro administrador ===');
    const otroAdmin = (await post('/api/personas', { nombre: 'Socio', usuario: 'socio',
      pin: '7777', cargo_id: 'admin' })).cuerpo.id;
    const aOtroAdmin = await post('/api/auth/como', { persona_id: otroAdmin });
    comp('se niega, porque no enseñaría nada distinto', aOtroAdmin.status === 400,
      aOtroAdmin.status + ' ' + JSON.stringify(aOtroAdmin.cuerpo));

    console.log('\n=== Un cargo sin permisos no abre nada ===');
    const pelado = (await post('/api/cargos', { nombre: 'Recién llegado',
      permisos: [] })).cuerpo.id;
    await post('/api/personas', { nombre: 'Nuevo', usuario: 'nuevo', pin: '8888',
      cargo_id: pelado, sitio_id: tienda });
    const tNuevo = (await post('/api/auth/entrar', { usuario: 'nuevo', pin: '8888' })).cuerpo.token;
    comp('entra en la aplicación', (await getComo(tNuevo, '/api/auth/yo')).status === 200);
    comp('pero no ve el catálogo', (await getComo(tNuevo, '/api/productos')).status === 403);
    comp('ni puede vender',
      (await postComo(tNuevo, '/api/ventas', { sitio_id: tienda, moneda: 'CUP',
        lineas: [{ producto_id: prod, cantidad: 1 }] })).status === 403);
    // Lo que sí, siempre: cambiarse su propio PIN y ver quién es.
    comp('y sí puede cambiarse su PIN, que no depende de ningún permiso',
      (await postComo(tNuevo, '/api/auth/mi-pin',
        { pin_actual: '8888', pin_nuevo: '9999' })).status === 200);

    console.log('\n' + (mal ? 'HAY ' + mal + ' FALLO(S)' : 'TODO BIEN') +
                ': ' + (ok + mal) + ' comprobaciones');
    cerrarTodo();
    process.exit(mal ? 1 : 0);
  } catch (e) {
    console.error('\nSE ROMPIÓ LA PRUEBA:', e.message);
    cerrarTodo();
    process.exit(1);
  }
})();
