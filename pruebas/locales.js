// CADA LOCAL VE SUS PRODUCTOS (DECISIONES.md #45), Y EL ALMACÉN PRINCIPAL NO ES
// UN LOCAL: ES EL MIRADOR (#48).
//
// Pedido por el dueño el 4 de septiembre de 2026: «los productos se crean en su
// apartado de productos y se asignan a los almacenes», con el almacén principal
// sumando lo de todos. Lo delicado no es esconderlos —eso es un filtro— sino no
// esconder de más: el almacén principal SURTE a los puntos, así que casi todo lo
// que una tienda vende se creó en el almacén. Con la regla literal, la tienda
// recibiría el despacho y no podría venderlo.
//
// Aquí se comprueban las dos mitades:
//
//   · que el servidor dice DE QUIÉN es cada producto y EN QUÉ LOCALES se ha
//     visto, que es de lo único que puede fiarse la pantalla;
//   · que un producto entra en esa lista al llegarle mercancía —traslado
//     recibido, entrada a mano— y NO se sale de ella al quedarse en cero;
//   · que la regla de la pantalla, tal como está escrita en app.js, enseña lo
//     de aquí, esconde lo de la tienda de al lado, y en el almacén principal lo
//     enseña todo;
//   · que se pueda crear un producto SIN local a propósito, para irles poniendo
//     local después, sin que eso se confunda con un aparato viejo que no manda el
//     campo —ahí manda el servidor y nunca lo deja suelto—;
//   · que mientras no tenga local salga SOLO en el apartado de Productos, y en
//     ningún local, ni siquiera en el almacén principal;
//   · pero que a un producto que ya está sirviendo en un local —tiene mercancía
//     suya— no se le esconda nunca, aunque se quede sin local;
//   · que ponérselo y quitárselo después funcione, y que guardarle solo el precio
//     no se lo quite sin querer;
//   · que la casilla de «¿cuánto tienes ahora?» aparezca y desaparezca con el
//     local, porque la mercancía tiene que estar EN algún sitio;
//   · que el ALMACÉN PRINCIPAL, que es el que siembra la aplicación, no acepte
//     nada: ni que se le asigne un producto, ni mercancía, ni una venta, ni
//     dinero, ni el reparto escondido dentro de una línea de inversión; pero que
//     MIRAR sí se pueda, que es justo para lo que existe;
//   · que la migración devuelva a «sin local» lo que aquella otra le dio, y que
//     no vuelva a correr;
//   · y que DUPLICAR un producto abra una ficha para crear OTRO, no para cambiar
//     el que se copió, que es la forma de perder el original sin enterarse.
//
//   node pruebas/locales.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const raiz = path.join(__dirname, '..');
const patio = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-locales-'));

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
const post = (ruta, cuerpo) => pedir(ruta, { method: 'POST', body: JSON.stringify(cuerpo) });

// Sembrar sin mirar si entró es sembrar a ciegas, y una prueba que siembra a
// ciegas miente. Todo lo que prepara el terreno pasa por aquí y revienta si el
// servidor dijo que no.
async function debe(ruta, cuerpo, queEs) {
  const r = await post(ruta, cuerpo);
  if (r.status !== 200) throw new Error('no se pudo sembrar ' + queEs + ': ' +
    r.status + ' ' + JSON.stringify(r.cuerpo));
  return r.cuerpo;
}

// ─── Las reglas de la pantalla, sacadas del propio app.js ───────────────────
// No se copian aquí: se leen del archivo que se despliega. Una copia se queda
// vieja el día que alguien cambie la de verdad, y entonces la prueba dice que
// todo está bien mirando un código que ya no corre en ningún teléfono.
//
// Salen las cuatro juntas porque se apoyan la una en la otra: qué es un producto
// SUELTO, quién lo ve en un local, qué sale en el apartado de Productos y qué
// sale en el Almacén. Traer solo una sería traer media regla.
function reglasDeLaPantalla() {
  const js = fs.readFileSync(path.join(raiz, 'public/app.js'), 'utf8');
  const desde = js.indexOf('const estaSuelto = p =>');
  const ancla = js.indexOf('const productosDelAlmacen = () =>');
  if (desde < 0 || ancla < 0) throw new Error('no se encontraron las reglas en public/app.js');
  const hasta = js.indexOf(';', js.indexOf('productosAqui();', ancla)) + 1;
  // enElMirador, sitioActual, PRODUCTOS y $ son de la aplicación; aquí se los damos.
  return new Function('enElMirador', 'sitioActual', 'PRODUCTOS', '$',
    js.slice(desde, hasta) +
    '; return { veAqui, estaSuelto, productosAqui, productosDelApartado, productosDelAlmacen };');
}
// Las reglas puestas a mirar desde un local concreto. 'alcance' es lo que estaría
// elegido en el desplegable del Almacén: «sitio» o «todos».
const HAZ_REGLAS = reglasDeLaPantalla();
const mirandoDesde = (local, esElMirador, productos, alcance) =>
  HAZ_REGLAS(() => !!esElMirador, () => local, productos || [],
             () => ({ value: alcance || 'sitio' }));

// La ficha de producto, sacada del propio app.js y puesta a funcionar contra un
// formulario de mentira. No se lee buscando un texto: se EJECUTA, que es la única
// forma de comprobar que duplicar no acaba editando el original, y la única de
// saber si la casilla de la existencia se enseña o no.
//
// El formulario falso solo apunta lo que le escriben. Todo lo que la ficha llama
// por el camino —las equivalencias de moneda, la foto, las listas de la unidad y
// del bulto— se le da vacío: aquí no se mira eso, se mira qué queda escrito en
// cada casilla.
function fichaDeProducto(productos, sitios, local, permisos) {
  const js = fs.readFileSync(path.join(raiz, 'public/app.js'), 'utf8');
  const desde = js.indexOf('function abrirFicha(id, copiar)');
  if (desde < 0) throw new Error('no se encontró abrirFicha(id, copiar) en public/app.js');
  const fin = js.indexOf('function alCambiarLocalDeLaFicha');
  if (fin < 0) throw new Error('no se encontró alCambiarLocalDeLaFicha en public/app.js');
  // Hasta la llave que cierra esa última función. Se busca «salto de línea + }» y
  // no «\n}\n»: el archivo lleva finales de línea de Windows, y con el remate de
  // tres letras el recorte salía vacío y la prueba se rompía diciendo que no
  // existía una función que sí existe.
  const hasta = js.indexOf('\n}', fin) + 2;

  const campos = {};
  const $ = id => (campos[id] = campos[id] ||
    { style: {}, classList: { add() {}, remove() {} }, focus() {}, select() {} });
  const nada = () => {};
  const puedo = (...cuales) => cuales.every(c => (permisos || ['*']).includes('*') ||
    (permisos || []).includes(c));
  // sitiosReales y enElMirador se le dan hechos, con la MISMA regla que la
  // aplicación: la ficha ya no ofrece el mirador como local, y eso es justo una de
  // las cosas que hay que comprobar aquí.
  const hazlo = new Function('$', 'PRODUCTOS', 'SITIOS', 'puedo', 'esc', 'sitioActual',
    'MONEDA_BASE', 'pintarFoto', 'ponerListasDelProducto', 'equivalenciaCosto',
    'equivalencia', 'alCambiarComision', 'setTimeout', 'sitiosReales', 'enElMirador',
    'esMirador',
    'let editando = null, FICHA_PRODUCTO = null, fotoActual, fichaNaciendo = false;\n' +
    js.slice(desde, hasta) +
    '\nreturn { abrirFicha, alCambiarLocalDeLaFicha, localDeLaFicha,' +
    ' estado: () => ({ editando, FICHA_PRODUCTO, fotoActual, fichaNaciendo }) };');
  const esMirador = id => id === 'principal';
  const api = hazlo($, productos, sitios, puedo, x => String(x == null ? '' : x),
    () => local, 'CUP', nada, nada, nada, nada, nada, nada,
    () => sitios.filter(x => !esMirador(x.id)), () => esMirador(local), esMirador);
  return Object.assign({}, api, { campos });
}

(async () => {
  try {
    const PUERTO = await puertoLibre();
    BASE = 'http://127.0.0.1:' + PUERTO;
    await arrancar({ PUERTO, DP_DB: path.join(patio, 'app.db'), DP_HTTP: '1' },
                   /D´Padrones/);

    await post('/api/auth/crear-admin', { nombre: 'Jefe', usuario: 'jefe', pin: '1234' });
    const ses = await post('/api/auth/entrar', { usuario: 'jefe', pin: '1234' });
    cab = { Authorization: 'Bearer ' + ses.cuerpo.token };

    console.log('\n=== El mirador, un almacén de verdad y dos tiendas ===');
    // EL «ALMACÉN PRINCIPAL» QUE SIEMBRA LA APLICACIÓN NO ES UN SITIO: es el
    // mirador, desde donde se ven los totales de todos sumados (#48). Los locales
    // de verdad son los que crea el dueño.
    const sitios = (await pedir('/api/sitios')).cuerpo;
    const PRINCIPAL = sitios[0].id;
    comp('el mirador está, y es el que siembra la aplicación', PRINCIPAL === 'principal',
      JSON.stringify(sitios.map(x => x.id)));
    const ALMACEN = (await debe('/api/sitios', { nombre: 'Almacén Central', tipo: 'almacen' },
      'el almacén')).id;
    const TIENDA = (await debe('/api/sitios', { nombre: 'Tienda', tipo: 'punto' }, 'la tienda')).id;
    const KIOSCO = (await debe('/api/sitios', { nombre: 'Kiosco', tipo: 'punto' }, 'el kiosco')).id;

    console.log('\n=== Cada producto nace del local que lo crea ===');
    const refresco = (await debe('/api/productos',
      { nombre: 'Refresco de cola', precio: 300, sitio_id: ALMACEN }, 'el refresco')).id;
    const galleta = (await debe('/api/productos',
      { nombre: 'Galleta', precio: 500, sitio_id: TIENDA }, 'la galleta')).id;
    const cerveza = (await debe('/api/productos',
      { nombre: 'Cerveza', precio: 700, sitio_id: KIOSCO }, 'la cerveza')).id;

    const de = async id => ((await pedir('/api/productos')).cuerpo.productos || [])
      .find(p => p.id === id) || {};
    comp('el refresco es del almacén', (await de(refresco)).sitio_id === ALMACEN);
    comp('la galleta es de la tienda', (await de(galleta)).sitio_id === TIENDA);
    comp('la cerveza es del kiosco', (await de(cerveza)).sitio_id === KIOSCO);

    console.log('\n=== Sin local puesto, el producto es del local de quien lo crea ===');
    // El aparato manda siempre el local, pero un aparato viejo puede no hacerlo:
    // entonces manda el servidor, que pone el de quien lo crea. Y si quien lo crea
    // no tiene local —el dueño, que trabaja en todos—, el producto nace SIN LOCAL
    // y no en el mirador, que no guarda nada (#48). Sin local se ve en Productos,
    // que es desde donde se reparte; en el mirador no se veria en ninguna parte.
    const sinDecir = (await debe('/api/productos',
      { nombre: 'Servilleta', precio: 5 }, 'la servilleta')).id;
    comp('el jefe no tiene local, así que el producto nace sin local',
      (await de(sinDecir)).sitio_id === null, (await de(sinDecir)).sitio_id);

    console.log('\n=== Y sin local A PROPÓSITO, para ponérselo después ===');
    // Mandar el local VACÍO y NO MANDARLO son dos cosas distintas y no se pueden
    // confundir: lo segundo es un aparato que no sabe de esto, y ahí manda el
    // servidor —que nunca deja el producto suelto—.
    const suelto = (await debe('/api/productos',
      { nombre: 'Caramelo', precio: 3, sitio_id: '' }, 'el caramelo')).id;
    comp('con el local vacío, el producto se queda sin local',
      (await de(suelto)).sitio_id === null, JSON.stringify((await de(suelto)).sitio_id));

    // Y AQUÍ ESTÁ LO QUE PIDIÓ: un producto sin local no sale en ningún local, ni
    // siquiera en el mirador. Sale SOLO en el apartado de Productos, que es donde
    // se le pone uno.
    const catalogo = async () => (await pedir('/api/productos')).cuerpo.productos;
    const reglasTienda = mirandoDesde(TIENDA, false, await catalogo());
    const reglasMirador = mirandoDesde(PRINCIPAL, true, await catalogo());
    comp('un producto sin local NO sale en la tienda',
      !reglasTienda.veAqui(await de(suelto)));
    comp('ni en el almacén principal, que lo ve todo lo demás',
      !reglasMirador.veAqui(await de(suelto)));
    comp('ni en el almacén sumando todo el negocio: ahí se cuentan existencias',
      !mirandoDesde(PRINCIPAL, true, await catalogo(), 'todos')
        .productosDelAlmacen().some(p => p.id === suelto));
    comp('pero SÍ en el apartado de Productos, que es donde se le pone local',
      reglasTienda.productosDelApartado().some(p => p.id === suelto),
      reglasTienda.productosDelApartado().map(p => p.nombre).join(', '));

    const inventado = await post('/api/productos',
      { nombre: 'Fantasma', precio: 1, sitio_id: 'este-local-no-existe' });
    comp('un local inventado no cuela: se dice que no existe', inventado.status === 400,
      inventado.status + ' ' + JSON.stringify(inventado.cuerpo));

    const ponerlo = await pedir('/api/productos/' + suelto, { method: 'PUT',
      body: JSON.stringify({ nombre: 'Caramelo', precio: 3, sitio_id: TIENDA }) });
    comp('ponerle el local después se lo pone', ponerlo.status === 200 &&
      (await de(suelto)).sitio_id === TIENDA, JSON.stringify((await de(suelto)).sitio_id));
    // La trampa de siempre: no mandar el campo tiene que significar «déjalo donde
    // está», o guardarle el precio desde un teléfono viejo lo dejaría suelto.
    await pedir('/api/productos/' + suelto, { method: 'PUT',
      body: JSON.stringify({ nombre: 'Caramelo', precio: 9 }) });
    comp('guardarle solo el precio NO le quita el local',
      (await de(suelto)).sitio_id === TIENDA, JSON.stringify((await de(suelto)).sitio_id));
    await pedir('/api/productos/' + suelto, { method: 'PUT',
      body: JSON.stringify({ nombre: 'Caramelo', precio: 9, sitio_id: '' }) });
    comp('y quitárselo a propósito sí se lo quita',
      (await de(suelto)).sitio_id === null, JSON.stringify((await de(suelto)).sitio_id));
    // Y un local inventado al EDITAR se rechaza antes de escribir nada: un 400
    // después de haber guardado el nombre deja la pantalla diciendo que no se
    // guardó y la base diciendo que sí.
    const editarMal = await pedir('/api/productos/' + suelto, { method: 'PUT',
      body: JSON.stringify({ nombre: 'Caramelo mentiroso', precio: 9, sitio_id: 'nada' }) });
    comp('editar con un local inventado se rechaza', editarMal.status === 400);
    comp('y no llega a cambiar el nombre: no se escribe nada a medias',
      (await de(suelto)).nombre === 'Caramelo', (await de(suelto)).nombre);

    console.log('\n=== Y lo que ESTÁ SIRVIENDO en un local no se esconde nunca ===');
    // La mitad que puede hacer daño de verdad: esconder un producto sin local está
    // bien mientras nadie tenga mercancía suya. Si la tiene, esconderlo sería dejar
    // esa mercancía sin poder venderse y sin que nadie entienda por qué. Por eso
    // «suelto» es sin local Y sin movimientos.
    const conStock = (await debe('/api/productos',
      { nombre: 'Agua', precio: 4, sitio_id: TIENDA }, 'el agua')).id;
    await debe('/api/movimientos', { tipo: 'compra', sitio_id: TIENDA,
      producto_id: conStock, cantidad: 30, costo_unit: 2 }, 'la entrada de agua');
    // Se le quita el local a un producto que SÍ tiene mercancía en la tienda.
    await pedir('/api/productos/' + conStock, { method: 'PUT',
      body: JSON.stringify({ nombre: 'Agua', precio: 4, sitio_id: '' }) });
    comp('se le quitó el local', (await de(conStock)).sitio_id === null);
    const yaSirve = mirandoDesde(TIENDA, false, await catalogo());
    comp('pero NO está suelto: la tienda tiene mercancía suya',
      !yaSirve.estaSuelto(await de(conStock)));
    comp('y por eso se sigue vendiendo en la tienda, que es lo que importa',
      yaSirve.veAqui(await de(conStock)));
    comp('el kiosco, que nunca lo tuvo, sigue sin verlo',
      !mirandoDesde(KIOSCO, false, await catalogo()).veAqui(await de(conStock)));
    // Se le devuelve el local para no dejar el patio raro para lo que viene.
    await pedir('/api/productos/' + conStock, { method: 'PUT',
      body: JSON.stringify({ nombre: 'Agua', precio: 4, sitio_id: TIENDA }) });

    console.log('\n=== La ficha: el local manda sobre «¿cuánto tienes ahora?» ===');
    // La mercancía tiene que estar EN algún sitio. Un producto que se deja
    // «todavía sin local» no tiene dónde meterla, y por eso no suma en ninguna
    // parte: la casilla desaparece con él.
    const conLocal = fichaDeProducto(await catalogo(), (await pedir('/api/sitios')).cuerpo, TIENDA);
    conLocal.abrirFicha();
    comp('creando uno nuevo, el local propuesto es en el que se está trabajando',
      conLocal.campos['f-sitio'].value === TIENDA, conLocal.campos['f-sitio'].value);
    comp('y se pregunta cuánto hay',
      conLocal.campos['f-existencia-caja'].style.display === 'block',
      conLocal.campos['f-existencia-caja'].style.display);
    comp('diciendo en qué local va a entrar la mercancía',
      /Tienda/.test(conLocal.campos['f-existencia-pista'].innerHTML || ''),
      conLocal.campos['f-existencia-pista'].innerHTML);
    conLocal.campos['f-sitio'].value = '';
    conLocal.alCambiarLocalDeLaFicha();
    comp('al dejarlo «todavía sin local», la casilla desaparece',
      conLocal.campos['f-existencia-caja'].style.display === 'none',
      conLocal.campos['f-existencia-caja'].style.display);
    conLocal.campos['f-sitio'].value = KIOSCO;
    conLocal.alCambiarLocalDeLaFicha();
    comp('y al elegir otro local vuelve, con el nombre del nuevo',
      conLocal.campos['f-existencia-caja'].style.display === 'block' &&
      /Kiosco/.test(conLocal.campos['f-existencia-pista'].innerHTML || ''),
      conLocal.campos['f-existencia-pista'].innerHTML);
    comp('la entrada iría al local del PRODUCTO, no al que se esté mirando',
      conLocal.localDeLaFicha() === KIOSCO, conLocal.localDeLaFicha());

    // Quien no puede ver el negocio entero no elige local: crea en el suyo. Si se
    // leyera el desplegable escondido, le saldría lo que hubiera quedado ahí.
    const sinElegir = fichaDeProducto(await catalogo(), (await pedir('/api/sitios')).cuerpo,
      TIENDA, ['gestionar_productos', 'gestionar_inventario']);
    sinElegir.abrirFicha();
    sinElegir.campos['f-sitio'].value = KIOSCO;
    comp('quien no elige local crea en el suyo, pase lo que pase en el desplegable',
      sinElegir.localDeLaFicha() === TIENDA, sinElegir.localDeLaFicha());
    // Y sin permiso de mover mercancía no se pregunta: crearía el producto y el
    // servidor le rechazaría la entrada después.
    const soloCatalogo = fichaDeProducto(await catalogo(), (await pedir('/api/sitios')).cuerpo,
      TIENDA, ['gestionar_productos']);
    soloCatalogo.abrirFicha();
    comp('sin permiso de mover mercancía no se pregunta la existencia',
      soloCatalogo.campos['f-existencia-caja'].style.display === 'none');

    console.log('\n=== Duplicar crea OTRO producto, no cambia este ===');
    const ficha = fichaDeProducto(await catalogo(), (await pedir('/api/sitios')).cuerpo, TIENDA);
    ficha.abrirFicha(refresco, true);
    comp('al duplicar no se está editando nada: al guardar nacerá otro',
      ficha.estado().editando === null, ficha.estado().editando);
    comp('el nombre viene marcado como copia',
      ficha.campos['f-nombre'].value === 'Refresco de cola (copia)',
      ficha.campos['f-nombre'].value);
    comp('el código del fabricante NO se copia: es el de la caja de ese',
      ficha.campos['f-codbarra'].value === '', ficha.campos['f-codbarra'].value);
    comp('el precio sí se copia',
      Number(ficha.campos['f-precio'].value) === 300, ficha.campos['f-precio'].value);
    comp('y el local del original se mantiene',
      ficha.campos['f-sitio'].value === (await de(refresco)).sitio_id,
      ficha.campos['f-sitio'].value);
    comp('no se ofrece eliminar: todavía no hay nada que eliminar',
      ficha.campos['btn-borrar'].style.display === 'none');
    comp('ni duplicar la copia, que todavía no existe',
      ficha.campos['btn-duplicar'].style.display === 'none');

    ficha.abrirFicha(refresco);
    comp('y abrirlo normal sigue editando ESE producto',
      ficha.estado().editando === refresco, ficha.estado().editando);
    comp('con su nombre tal cual, sin marca de copia',
      ficha.campos['f-nombre'].value === 'Refresco de cola', ficha.campos['f-nombre'].value);
    comp('y con el código del fabricante que tuviera',
      ficha.campos['f-codbarra'].value === ((await de(refresco)).codigo_barra || ''));
    comp('editando no se pregunta la existencia: sería pisar el historial',
      ficha.campos['f-existencia-caja'].style.display === 'none');

    console.log('\n=== En qué locales se ha visto cada producto ===');
    comp('recién creado, en ninguno: nadie ha tenido mercancía suya',
      (await de(refresco)).sitios.length === 0);

    await debe('/api/movimientos', { tipo: 'compra', sitio_id: ALMACEN,
      producto_id: refresco, cantidad: 10, costo_unit: 200 }, 'la entrada de refrescos');
    comp('entra mercancía en el almacén y el refresco se ve allí',
      (await de(refresco)).sitios.join() === ALMACEN);

    console.log('\n=== El almacén despacha a la tienda, y la tienda puede venderlo ===');
    const tras = await debe('/api/traslados', { origen_id: ALMACEN, destino_id: TIENDA,
      lineas: [{ producto_id: refresco, cantidad: 4 }] }, 'el traslado');
    comp('mientras va de camino, la tienda todavía no lo ve',
      !(await de(refresco)).sitios.includes(TIENDA));
    await debe('/api/traslados/' + tras.id + '/recibir',
      { lineas: [{ producto_id: refresco, cantidad: 4 }] }, 'la recepción');
    comp('recibido, el refresco ya es también de la tienda',
      (await de(refresco)).sitios.includes(TIENDA), JSON.stringify((await de(refresco)).sitios));
    comp('y sigue siendo del almacén: el dueño no cambia al mover una caja',
      (await de(refresco)).sitio_id === ALMACEN);
    comp('el kiosco sigue sin verlo',
      !(await de(refresco)).sitios.includes(KIOSCO));

    console.log('\n=== Quedarse en cero NO borra el producto de esa tienda ===');
    // Es la parte que se olvida: si desapareciera al agotarse, se iría de la
    // pantalla justo el día que hay que pedir más.
    await debe('/api/movimientos', { tipo: 'merma', sitio_id: TIENDA,
      producto_id: refresco, cantidad: 4, motivo: 'Rotura' }, 'la merma');
    const enLaTienda = (await pedir('/api/stock?sitio_id=' + TIENDA)).cuerpo.stock || {};
    comp('la tienda se quedó sin ninguno', !enLaTienda[refresco], enLaTienda[refresco]);
    comp('y el refresco se sigue viendo en la tienda',
      (await de(refresco)).sitios.includes(TIENDA));

    console.log('\n=== La regla de la pantalla (public/app.js) ===');
    const catFinal = await catalogo();
    const enTienda = mirandoDesde(TIENDA, false, catFinal).veAqui;
    const enKiosco = mirandoDesde(KIOSCO, false, catFinal).veAqui;
    const enElMiradorVe = mirandoDesde(PRINCIPAL, true, catFinal).veAqui;

    const R = await de(refresco), G = await de(galleta), C = await de(cerveza);
    comp('la tienda ve lo suyo', enTienda(G));
    comp('la tienda ve lo que le despacharon aunque sea del almacén', enTienda(R));
    comp('la tienda NO ve lo del kiosco', !enTienda(C));
    comp('el kiosco NO ve lo de la tienda', !enKiosco(G));
    comp('el kiosco NO ve el refresco: nunca le llegó', !enKiosco(R));
    comp('desde el mirador se ve todo, que es para lo que existe',
      enElMiradorVe(R) && enElMiradorVe(G) && enElMiradorVe(C));
    comp('un producto sin local no se ve en ningún local',
      !enTienda({ sitio_id: null, sitios: [] }) && !enKiosco({ sitio_id: '', sitios: [] }));
    comp('pero sin local Y con mercancía en la tienda, la tienda lo sigue viendo',
      enTienda({ sitio_id: null, sitios: [TIENDA] }));

    console.log('\n=== El almacén principal es la suma de todos ===');
    // Mirando «todo el negocio, sumado» salen los productos de todos los locales,
    // que es justo lo que se ha pedido ver. Es la decisión #22, y la #45 solo le
    // quita los que todavía no son de nadie.
    const sumando = mirandoDesde(PRINCIPAL, true, catFinal, 'todos').productosDelAlmacen();
    comp('sumando todo el negocio salen los de las tres partes',
      [refresco, galleta, cerveza].every(id => sumando.some(p => p.id === id)),
      sumando.map(p => p.nombre).join(', '));
    const soloTienda = mirandoDesde(TIENDA, false, catFinal, 'sitio').productosDelAlmacen();
    comp('y mirando solo la tienda, no sale lo del kiosco',
      !soloTienda.some(p => p.id === cerveza));

    console.log('\n=== En el mirador no se guarda nada, y lo dice el SERVIDOR ===');
    // El «Almacén Principal» que siembra la aplicación no es un local: es desde
    // donde se ven los totales de todos sumados (#48). Se comprueba en el servidor
    // y no escondiendo opciones en la pantalla, que es decoración (#10): un
    // teléfono con el código viejo en su caché sigue ofreciéndolo en cada
    // desplegable, y sin esto colaría.
    const alMirador = (ruta, cuerpo) => post(ruta, cuerpo).then(r => r.status);
    comp('un producto no se puede asignar al mirador',
      (await alMirador('/api/productos',
        { nombre: 'Fantasma', precio: 1, sitio_id: PRINCIPAL })) === 400);
    const cambiarlo = await pedir('/api/productos/' + galleta, { method: 'PUT',
      body: JSON.stringify({ nombre: 'Galleta', precio: 500, sitio_id: PRINCIPAL }) });
    comp('ni mudarlo al mirador después', cambiarlo.status === 400,
      cambiarlo.status + ' ' + JSON.stringify(cambiarlo.cuerpo));
    comp('y el producto se queda donde estaba',
      (await de(galleta)).sitio_id === TIENDA, (await de(galleta)).sitio_id);
    comp('no entra mercancía en el mirador',
      (await alMirador('/api/movimientos', { tipo: 'compra', sitio_id: PRINCIPAL,
        producto_id: galleta, cantidad: 5, costo_unit: 1 })) === 400);
    comp('no se le transfiere nada',
      (await alMirador('/api/traslados', { origen_id: TIENDA, destino_id: PRINCIPAL,
        lineas: [{ producto_id: galleta, cantidad: 1 }] })) === 400);
    comp('ni sale nada de él',
      (await alMirador('/api/traslados', { origen_id: PRINCIPAL, destino_id: TIENDA,
        lineas: [{ producto_id: galleta, cantidad: 1 }] })) === 400);
    comp('no se vende desde el mirador',
      (await alMirador('/api/ventas', { sitio_id: PRINCIPAL, moneda: 'CUP',
        lineas: [{ producto_id: galleta, cantidad: 1 }] })) === 400);
    comp('no pasa dinero por su caja',
      (await alMirador('/api/fondo', { tipo: 'ingreso', moneda: 'CUP', importe: 10,
        sitio_id: PRINCIPAL, concepto: 'Prueba' })) === 400);
    // Y una inversión no puede colar el mirador por la puerta de atrás, que va
    // dentro de las líneas y no arriba del cuerpo.
    comp('ni una inversión, que lo lleva escondido dentro de una línea',
      (await alMirador('/api/inversiones', { nombre: 'Compra', moneda: 'CUP',
        sitio_id: TIENDA, lineas: [{ producto_id: galleta, cantidad: 2, costo_unit: 1,
          reparto: [{ sitio_id: PRINCIPAL, cantidad: 2 }] }] })) === 400);
    // MIRAR sí se puede: es justo para lo que existe.
    comp('pero mirar sí se puede, que es para lo que está',
      (await pedir('/api/stock?sitio_id=' + PRINCIPAL)).status === 200);

    console.log('\n=== La migración devuelve a su sitio lo que el mirador se quedó ===');
    // La #45 traía de la otra aplicación una migración que daba al mirador los
    // productos sin local. Allí está bien —allí ES un almacén de verdad—; aquí no,
    // y esta la deshace: los devuelve a «todavía sin local», que es de donde el
    // dueño los reparte.
    const abrirBase = () => require('better-sqlite3')(path.join(patio, 'app.db'));
    const reiniciar = async () => {
      cerrarTodo();
      const puerto = await puertoLibre();
      BASE = 'http://127.0.0.1:' + puerto;
      await arrancar({ PUERTO: puerto, DP_DB: path.join(patio, 'app.db'), DP_HTTP: '1' },
                     /D´Padrones/);
      const ses = await post('/api/auth/entrar', { usuario: 'jefe', pin: '1234' });
      cab = { Authorization: 'Bearer ' + ses.cuerpo.token };
    };

    let db = abrirBase();
    db.prepare("UPDATE productos SET sitio_id='principal' WHERE id=?").run(cerveza);
    db.prepare("DELETE FROM ajustes WHERE clave='mirador_no_es_un_sitio'").run();
    db.close();
    await reiniciar();
    comp('un producto que se quedó en el mirador vuelve a «sin local»',
      (await de(cerveza)).sitio_id === null, (await de(cerveza)).sitio_id);
    comp('y los demás no se tocan',
      (await de(refresco)).sitio_id === ALMACEN, (await de(refresco)).sitio_id);

    // Y corre UNA VEZ. Si corriera en cada arranque, un producto que alguien
    // pusiera a mano donde toca volvería a quedarse sin local solo.
    db = abrirBase();
    db.prepare('UPDATE productos SET sitio_id=? WHERE id=?').run(TIENDA, cerveza);
    db.close();
    await reiniciar();
    comp('la migración NO vuelve a correr: lo asignado se queda asignado',
      (await de(cerveza)).sitio_id === TIENDA, (await de(cerveza)).sitio_id);

    console.log('\n' + (mal ? 'HAY ' + mal + ' FALLO(S): ' : 'TODO BIEN: ') +
                (ok + mal) + ' comprobaciones');
    cerrarTodo();
    process.exit(mal ? 1 : 0);
  } catch (e) {
    console.error('\n  MAL  la prueba se rompió: ' + e.message);
    cerrarTodo();
    process.exit(1);
  }
})();
