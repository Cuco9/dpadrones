// CAJAS Y SACOS: se escribe en bultos y se guarda en unidades.
//
// Pedido por el dueño el 3 de septiembre de 2026: «en el almacén principal tengo
// productos por cantidades en cajas o sacos, y cuando paso a otro de mis
// almacenes necesito poder pasar esos productos convertidos a unidades».
//
// La decisión (#44) es que por dentro TODO son unidades, siempre, y que la caja
// es una forma de ESCRIBIR la cantidad y de LEERLA, nunca un dato guardado. Lo
// contrario —el almacén contando cajas y la tienda unidades— sería que el mismo
// número significara dos cosas según dónde se mire, y entonces el valor del
// inventario, el mínimo y un traslado dejarían de significar nada.
//
// Lo que se comprueba aquí es lo que puede salir mal sin que se note:
//
//   · que escribir «3 cajas» guarde 72 unidades y no 3, en los tres caminos que
//     mueven mercancía a mano: entrada, merma y traslado;
//   · que la cuenta la haga el SERVIDOR, de modo que un dispositivo con el código
//     viejo —que no manda la medida— siga metiendo unidades y no cajas;
//   · que un producto sin bulto puesto se NIEGUE a aceptar cajas en vez de
//     guardar la cifra tal cual, que es meter mercancía de menos sin enterarse;
//   · que el freno de «no se rebaja lo que no está» (#40) cuente en unidades;
//   · y que cambiar cuántas unidades trae una caja NO toque ni un movimiento ya
//     escrito: lo guardado son unidades.
//
//   node pruebas/bultos.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const raiz = path.join(__dirname, '..');
const patio = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-bul-'));

let ok = 0, mal = 0;
const comp = (nombre, cierto, extra) => {
  if (cierto) { ok++; console.log('  ok   ' + nombre); }
  else { mal++; console.log('  MAL  ' + nombre + (extra !== undefined ? '  → ' + extra : '')); }
};
const casi = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

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

async function debe(ruta, cuerpo, queEs) {
  const r = await post(ruta, cuerpo);
  if (r.status !== 200) throw new Error('no se pudo sembrar ' + queEs + ': ' +
    r.status + ' ' + JSON.stringify(r.cuerpo));
  return r.cuerpo;
}
const stockDe = async sitio =>
  (await pedir('/api/stock?sitio_id=' + encodeURIComponent(sitio))).cuerpo.stock || {};
const elProducto = async id => ((await pedir('/api/productos')).cuerpo.productos || [])
  .find(p => p.id === id) || {};

(async () => {
  try {
    const PUERTO = await puertoLibre();
    BASE = 'http://127.0.0.1:' + PUERTO;
    await arrancar({ PUERTO, DP_DB: path.join(patio, 'app.db'), DP_HTTP: '1' },
                   /D´Padrones/);

    console.log('\n=== Un almacén, una tienda y un producto que viene en cajas ===');
    await post('/api/auth/crear-admin', { nombre: 'Jefe', usuario: 'jefe', pin: '1234' });
    const ses = await post('/api/auth/entrar', { usuario: 'jefe', pin: '1234' });
    cab = { Authorization: 'Bearer ' + ses.cuerpo.token };
    // El «Almacén Principal» que siembra la aplicación es el MIRADOR: desde ahí se
    // ven los totales de todos sumados y no se guarda nada (DECISIONES.md #48).
    // El almacén de verdad, el que tiene la mercancía, se crea aquí.
    const almacen = (await post('/api/sitios',
      { nombre: 'Almacén Central', tipo: 'almacen' })).cuerpo.id;
    const tienda = (await debe('/api/sitios',
      { nombre: 'Tienda Centro', tipo: 'punto', padre_id: almacen }, 'la tienda')).id;

    const lata = (await debe('/api/productos', { nombre: 'Refresco en lata', precio: 150,
      costo: 90, um: 'Unidad', unidades_por_caja: 24, nombre_caja: 'Caja' }, 'la lata')).id;
    const clavo = (await debe('/api/productos', { nombre: 'Clavo 2 pulgadas', precio: 5,
      costo: 3, um: 'Unidad' }, 'el clavo')).id;

    const p = await elProducto(lata);
    comp('el producto guarda cuántas unidades trae la caja', p.unidades_por_caja === 24,
      p.unidades_por_caja);
    comp('y cómo se llama el bulto', p.nombre_caja === 'Caja', p.nombre_caja);
    comp('el que no viene en bultos se queda en cero',
      (await elProducto(clavo)).unidades_por_caja === 0);

    console.log('\n=== Entra mercancía escrita en CAJAS ===');
    await debe('/api/movimientos', { tipo: 'compra', sitio_id: almacen, producto_id: lata,
      cantidad: 10, medida: 'caja', costo_unit: 90 }, 'la entrada en cajas');
    comp('«10 cajas» son 240 unidades, no 10',
      casi((await stockDe(almacen))[lata], 240), (await stockDe(almacen))[lata]);

    // Esto es lo que pasa con un dispositivo que todavía tiene el código viejo:
    // no manda la medida, y entonces lo que manda son unidades. Tiene que seguir
    // siendo así, o al desplegar esto todas las entradas se multiplicarían por 24.
    await debe('/api/movimientos', { tipo: 'compra', sitio_id: almacen, producto_id: lata,
      cantidad: 6, costo_unit: 90 }, 'la entrada sin medida');
    comp('sin decir la medida se guardan UNIDADES, como siempre',
      casi((await stockDe(almacen))[lata], 246), (await stockDe(almacen))[lata]);

    const sinBulto = await post('/api/movimientos', { tipo: 'compra', sitio_id: almacen,
      producto_id: clavo, cantidad: 3, medida: 'caja', costo_unit: 3 });
    comp('en cajas, un producto sin bulto puesto se NIEGA', sinBulto.status === 400,
      sinBulto.status + ' ' + JSON.stringify(sinBulto.cuerpo));
    comp('y dice dónde se pone', /ficha del producto/i.test(sinBulto.cuerpo.error || ''),
      sinBulto.cuerpo.error);
    comp('sin guardar nada: el clavo sigue sin existencia', !(await stockDe(almacen))[clavo]);

    console.log('\n=== Y AQUÍ ESTÁ LO QUE SE PIDIÓ: el almacén despacha cajas ===');
    // «Cuando paso a otro de mis almacenes necesito poder pasar esos productos
    // convertidos a unidades»: se escriben 3 cajas y llegan 72 unidades.
    const envio = await debe('/api/traslados', { origen_id: almacen, destino_id: tienda,
      lineas: [{ producto_id: lata, cantidad: 3, medida: 'caja' }] }, 'el despacho');
    comp('del almacén salen 72 unidades, no 3',
      casi((await stockDe(almacen))[lata], 174), (await stockDe(almacen))[lata]);

    await debe('/api/traslados/' + envio.id + '/recibir',
      { lineas: [{ producto_id: lata, cantidad: 72 }] }, 'la recepción');
    comp('y en la tienda entran 72 unidades', casi((await stockDe(tienda))[lata], 72),
      (await stockDe(tienda))[lata]);
    comp('el mismo número a los dos lados: por dentro todo son unidades',
      casi((await stockDe(tienda))[lata], 72) && casi((await stockDe(almacen))[lata], 174));

    console.log('\n=== Recibir contando cajas también vale ===');
    const envio2 = await debe('/api/traslados', { origen_id: almacen, destino_id: tienda,
      lineas: [{ producto_id: lata, cantidad: 2, medida: 'caja' }] }, 'el segundo despacho');
    // Llegó una caja rota: se recibe 1 caja de las 2 que salieron.
    const rec2 = await post('/api/traslados/' + envio2.id + '/recibir',
      { lineas: [{ producto_id: lata, cantidad: 1, medida: 'caja' }] });
    comp('se recibe «1 caja» y entran 24 unidades', rec2.status === 200 &&
      casi((await stockDe(tienda))[lata], 96), (await stockDe(tienda))[lata]);
    comp('y el traslado queda como recibido a medias', rec2.cuerpo.completo === false,
      JSON.stringify(rec2.cuerpo));

    const deMas = await post('/api/traslados', { origen_id: almacen, destino_id: tienda,
      lineas: [{ producto_id: lata, cantidad: 100, medida: 'caja' }] });
    comp('despachar más cajas de las que hay se niega', deMas.status === 400, deMas.status);
    comp('y la cuenta del freno está en unidades, no en cajas',
      /2400/.test(deMas.cuerpo.error || ''), deMas.cuerpo.error);

    console.log('\n=== Y SE VENDE POR CAJAS, no solo por unidades ===');
    // Pedido por el dueño el 4 de septiembre de 2026 (DECISIONES.md #51): «desde el
    // almacén vendo por sacos y si transfiero a la tienda es para vender por unidad
    // pero a otro precio». La #44 dejó fuera la caja de venta a propósito porque
    // nadie la había pedido; ya está pedida.
    const antesVenta = (await stockDe(almacen))[lata];
    const vCaja = await post('/api/ventas', { sitio_id: almacen, moneda: 'CUP',
      lineas: [{ producto_id: lata, cantidad: 2, medida: 'caja' }] });
    comp('se vende «2 cajas» sin decir cuántas unidades son', vCaja.status === 200,
      vCaja.status + ' ' + JSON.stringify(vCaja.cuerpo).slice(0, 140));
    comp('y del estante salen 48 unidades, no 2',
      casi((await stockDe(almacen))[lata], antesVenta - 48),
      (await stockDe(almacen))[lata] + ' antes ' + antesVenta);
    // El precio es POR UNIDAD (#50), así que una caja son 24 × 150.
    comp('se cobra la caja entera: 24 × 150 = 3 600 por caja',
      casi(vCaja.cuerpo.total, 2 * 24 * 150), vCaja.cuerpo.total);

    // Y sigue valiendo la de siempre, que es la inmensa mayoría de las ventas.
    const vSuelta = await post('/api/ventas', { sitio_id: almacen, moneda: 'CUP',
      lineas: [{ producto_id: lata, cantidad: 3 }] });
    comp('sin decir la medida se venden unidades, como siempre',
      vSuelta.status === 200 && casi(vSuelta.cuerpo.total, 3 * 150),
      vSuelta.cuerpo.total);

    // Lo que no está no se vende, y la cuenta se hace EN UNIDADES: dos cajas de un
    // producto del que quedan diez unidades son cuarenta y ocho que no hay.
    const quedan = (await stockDe(almacen))[lata];
    const deMasEnCajas = await post('/api/ventas', { sitio_id: almacen, moneda: 'CUP',
      lineas: [{ producto_id: lata, cantidad: Math.ceil(quedan / 24) + 1, medida: 'caja' }] });
    comp('vender más cajas de las que hay se niega, contando en unidades',
      deMasEnCajas.status === 400, deMasEnCajas.status);
    // Y un producto sin bulto no acepta que le vendan «cajas»: dar por hecho que
    // una caja es una unidad es cobrar de menos y no enterarse.
    const clavoEnCajas = await post('/api/ventas', { sitio_id: almacen, moneda: 'CUP',
      lineas: [{ producto_id: clavo, cantidad: 1, medida: 'caja' }] });
    comp('y de lo que va suelto no se venden «cajas»', clavoEnCajas.status === 400,
      clavoEnCajas.status);

    console.log('\n=== La merma en cajas también cuenta en unidades (#40) ===');
    const antesMerma = (await stockDe(tienda))[lata];
    await debe('/api/movimientos', { tipo: 'merma', sitio_id: tienda, producto_id: lata,
      cantidad: 1, medida: 'caja', motivo: 'Rotura' }, 'la merma en cajas');
    comp('una caja rota son 24 unidades menos',
      casi((await stockDe(tienda))[lata], antesMerma - 24), (await stockDe(tienda))[lata]);
    const mermaGorda = await post('/api/movimientos', { tipo: 'merma', sitio_id: tienda,
      producto_id: lata, cantidad: 10, medida: 'caja', motivo: 'Rotura' });
    comp('y no se da de baja más de lo que hay', mermaGorda.status === 400, mermaGorda.status);

    console.log('\n=== Cambiar el tamaño de la caja NO reescribe nada ===');
    // Es lo que hace que esto sea seguro: lo guardado son unidades, así que
    // corregir «una caja trae 24» por «trae 12» no toca ni un movimiento. Lo
    // único que cambia es cómo se escriben y cómo se leen las cantidades desde
    // ese momento.
    const antesCambio = (await stockDe(almacen))[lata];
    await pedir('/api/productos/' + lata, { method: 'PUT', body: JSON.stringify({
      nombre: 'Refresco en lata', precio: 150, costo: 90, um: 'Unidad',
      unidades_por_caja: 12, nombre_caja: 'Paquete' }) });
    comp('la existencia no se mueve ni una unidad',
      casi((await stockDe(almacen))[lata], antesCambio), (await stockDe(almacen))[lata]);
    comp('y el producto ya cuenta con el bulto nuevo',
      (await elProducto(lata)).unidades_por_caja === 12);
    await debe('/api/movimientos', { tipo: 'compra', sitio_id: almacen, producto_id: lata,
      cantidad: 2, medida: 'caja', costo_unit: 90 }, 'la entrada con el bulto nuevo');
    comp('«2 paquetes» son ahora 24 unidades',
      casi((await stockDe(almacen))[lata], antesCambio + 24), (await stockDe(almacen))[lata]);

    console.log('\n=== La conversión vive en UNA función del servidor ===');
    // La misma cuenta escrita en cuatro sitios son cuatro cuentas que un día
    // dejan de coincidir. Aquí se comprueba que hay UNA y que por ella pasan todos
    // los caminos: entrada a mano, despacho, recepción y venta.
    const servidor = fs.readFileSync(path.join(raiz, 'server.js'), 'utf8');
    const usos = (servidor.match(/cantidadEnUnidades\(/g) || []).length;
    comp('hay una sola función y por ella pasan todos los caminos', usos === 5,
      usos + ' apariciones');
    // Desde el 4-sep-2026 la VENTA también pasa por ella (#51): hasta ese día solo
    // sabía de unidades, y no se podía vender un saco entero.
    comp('y la venta es uno de ellos',
      servidor.includes('cant = cantidadEnUnidades(prod, l.cantidad, l.medida)'));
    comp('y la pantalla NO multiplica por su cuenta antes de mandar',
      !/cantidad: *[a-z.]+ *\* *[a-z.]*unidades_por_caja/i
        .test(fs.readFileSync(path.join(raiz, 'public/app.js'), 'utf8')));

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
