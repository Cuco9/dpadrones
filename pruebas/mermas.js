// No se rebaja mercancía que no está: la merma, el ajuste, el despacho, la venta,
// el conteo y la cancelación de una inversión (DECISIONES.md #40).
//
// Pedido por el dueño el 22 de agosto de 2026: «la aplicación no puede dar mermas
// que excedan las existencias; si solo quedan 2 y la merma es 3 no puede ser,
// porque no existe el producto para darle merma. No se puede rebajar dinero que no
// existe y no se pueden rebajar productos que no existen».
//
// Lo que se comprueba aquí es lo que puede salir mal sin que se note:
//
//   · que la merma de más de lo que hay NO entre, y que el cartel diga la cifra;
//   · que al negarse no quede el movimiento apuntado a medias;
//   · que dar de baja EXACTAMENTE lo que hay sí se pueda: cero es normal;
//   · que cada sitio mire SU estante, no el del negocio entero;
//   · que el despacho compruebe antes de escribir nada, para que no quede un
//     traslado en tránsito de mercancía que nunca salió;
//   · que dos líneas del mismo producto se sumen antes de comparar;
//   · que el conteo del cierre no admita cantidades en negativo;
//   · y que cancelar una inversión cuya mercancía ya se vendió se pare, en vez de
//     dejar el inventario debiendo unidades.
//
//   node pruebas/mermas.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const raiz = path.join(__dirname, '..');
const patio = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-mer-'));

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
const hoy = new Date().toLocaleDateString('sv-SE');
const stockDe = async sitio =>
  (await pedir('/api/stock?sitio_id=' + encodeURIComponent(sitio))).cuerpo.stock || {};

(async () => {
  try {
    const PUERTO = await puertoLibre();
    BASE = 'http://127.0.0.1:' + PUERTO;
    await arrancar({ PUERTO, DP_DB: path.join(patio, 'app.db'), DP_HTTP: '1' },
                   /D´Padrones/);

    console.log('\n=== Preparar: un almacén, una tienda y dos paneles ===');
    await post('/api/auth/crear-admin', { nombre: 'Jefe', usuario: 'jefe', pin: '1234' });
    const ses = await post('/api/auth/entrar', { usuario: 'jefe', pin: '1234' });
    cab = { Authorization: 'Bearer ' + ses.cuerpo.token };
    await post('/api/tasa', { tasa: 400 });
    // El «Almacén Principal» que siembra la aplicación es el MIRADOR: desde ahí se
    // ven los totales de todos sumados y no se guarda nada (DECISIONES.md #48).
    // El almacén de verdad, el que tiene la mercancía, se crea aquí.
    const almacen = (await post('/api/sitios',
      { nombre: 'Almacén Central', tipo: 'almacen' })).cuerpo.id;
    const tienda = (await post('/api/sitios',
      { nombre: 'Tienda Centro', tipo: 'punto', padre_id: almacen })).cuerpo.id;

    const panel = (await post('/api/productos', { nombre: 'Panel 450W', precio: 20000,
      precio_moneda: 'CUP', costo: 14000, um: 'Unidad' })).cuerpo.id;
    const cable = (await post('/api/productos', { nombre: 'Cable 10mm', precio: 100,
      precio_moneda: 'CUP', costo: 60, um: 'Metro' })).cuerpo.id;

    // El caso que contó él: quedan 2 en la tienda.
    await post('/api/movimientos', { tipo: 'compra', sitio_id: tienda, producto_id: panel,
      cantidad: 2, costo_unit: 14000 });
    await post('/api/movimientos', { tipo: 'compra', sitio_id: almacen, producto_id: panel,
      cantidad: 10, costo_unit: 14000 });
    await post('/api/movimientos', { tipo: 'compra', sitio_id: tienda, producto_id: cable,
      cantidad: 50, costo_unit: 60 });
    comp('hay 2 paneles en la tienda', (await stockDe(tienda))[panel] === 2);
    comp('y 10 en el almacén', (await stockDe(almacen))[panel] === 10);

    console.log('\n=== Si quedan 2, no se dan de baja 3 ===');
    const tres = await post('/api/movimientos', { tipo: 'merma', sitio_id: tienda,
      producto_id: panel, cantidad: 3, motivo: 'Rotura' });
    comp('la merma de 3 con 2 en el estante se niega', tres.status === 400,
      tres.status + ' ' + JSON.stringify(tres.cuerpo));
    comp('y el cartel dice qué, dónde, cuánto queda y cuánto se saca',
      /Panel 450W/.test(tres.cuerpo.error || '') &&
      /Tienda Centro/.test(tres.cuerpo.error || '') &&
      /quedan 2/.test(tres.cuerpo.error || '') &&
      /sacando 3/.test(tres.cuerpo.error || ''), tres.cuerpo.error);
    comp('y dice qué hacer, no solo que no',
      /entrada/.test(tres.cuerpo.error || ''), tres.cuerpo.error);
    // Lo que se cuela si el freno se pone después de escribir: la merma queda
    // apuntada y el estante en −1, con el aviso en la pantalla diciendo que no.
    comp('al negarse NO queda el movimiento apuntado',
      (await stockDe(tienda))[panel] === 2, (await stockDe(tienda))[panel]);

    console.log('\n=== Cada sitio mira SU estante ===');
    // En el negocio entero hay 12 paneles: si el freno mirara el total, esta
    // merma de 3 en la tienda pasaría, y la tienda quedaría en −1.
    comp('tener 10 en el almacén no deja dar de baja 3 en la tienda',
      (await post('/api/movimientos', { tipo: 'merma', sitio_id: tienda,
        producto_id: panel, cantidad: 3, motivo: 'Rotura' })).status === 400);
    comp('pero en el almacén, donde sí están, entra',
      (await post('/api/movimientos', { tipo: 'merma', sitio_id: almacen,
        producto_id: panel, cantidad: 3, motivo: 'Rotura' })).status === 200);
    comp('y el almacén se queda con 7', casi((await stockDe(almacen))[panel], 7),
      (await stockDe(almacen))[panel]);

    console.log('\n=== Dar de baja exactamente lo que hay sí se puede ===');
    // Dejar el estante en cero es normal; dejarlo en negativo es imposible.
    const dos = await post('/api/movimientos', { tipo: 'merma', sitio_id: tienda,
      producto_id: panel, cantidad: 2, motivo: 'Rotura' });
    comp('la merma de los 2 que quedan entra', dos.status === 200, JSON.stringify(dos.cuerpo));
    comp('y la tienda se queda en cero', !(await stockDe(tienda))[panel],
      (await stockDe(tienda))[panel]);
    comp('la siguiente merma, con el estante vacío, ya se niega',
      (await post('/api/movimientos', { tipo: 'merma', sitio_id: tienda,
        producto_id: panel, cantidad: 1, motivo: 'Rotura' })).status === 400);
    const vacio = await post('/api/movimientos', { tipo: 'merma', sitio_id: tienda,
      producto_id: panel, cantidad: 1, motivo: 'Rotura' });
    comp('y con el estante vacío el cartel no dice «quedan 0», dice que no queda nada',
      /no queda nada/.test(vacio.cuerpo.error || ''), vacio.cuerpo.error);

    console.log('\n=== El ajuste que resta tampoco puede dejar el estante debiendo ===');
    const ajuMal = await post('/api/movimientos', { tipo: 'ajuste', sitio_id: tienda,
      producto_id: cable, cantidad: -60, motivo: 'Cuadre' });
    comp('un ajuste de −60 con 50 metros se niega', ajuMal.status === 400,
      ajuMal.status + ' ' + JSON.stringify(ajuMal.cuerpo));
    comp('el ajuste de −50 sí, que deja el estante en cero',
      (await post('/api/movimientos', { tipo: 'ajuste', sitio_id: tienda,
        producto_id: cable, cantidad: -50, motivo: 'Cuadre' })).status === 200);
    comp('y el ajuste que SUMA no se toca: entra siempre',
      (await post('/api/movimientos', { tipo: 'ajuste', sitio_id: tienda,
        producto_id: cable, cantidad: 30, motivo: 'Apareció' })).status === 200);
    comp('la tienda tiene ahora 30 metros', casi((await stockDe(tienda))[cable], 30),
      (await stockDe(tienda))[cable]);

    console.log('\n=== Despachar lo que no está: se para ANTES de escribir nada ===');
    const desp = await post('/api/traslados', { origen_id: tienda, destino_id: almacen,
      fecha: hoy, lineas: [{ producto_id: cable, cantidad: 40 }] });
    comp('el despacho de 40 metros con 30 se niega', desp.status === 400,
      desp.status + ' ' + JSON.stringify(desp.cuerpo));
    comp('y dice cuánto hay y cuánto se está sacando',
      /quedan 30/.test(desp.cuerpo.error || '') && /sacando 40/.test(desp.cuerpo.error || ''),
      desp.cuerpo.error);
    // Esto es lo que deja un freno puesto después de la cabecera: un traslado en
    // tránsito de mercancía que nunca salió, y el otro punto recibiéndola.
    comp('al negarse NO queda un traslado en tránsito',
      !(await pedir('/api/traslados?sitio_id=' + tienda)).cuerpo.traslados.length,
      JSON.stringify((await pedir('/api/traslados?sitio_id=' + tienda)).cuerpo.traslados));
    comp('y el estante de la tienda sigue igual', casi((await stockDe(tienda))[cable], 30));

    console.log('\n=== Dos líneas del mismo producto se SUMAN antes de comparar ===');
    // 20 + 20 metros: cada línea cabe en los 30 que hay, las dos juntas no.
    const dosLineas = await post('/api/traslados', { origen_id: tienda, destino_id: almacen,
      fecha: hoy, lineas: [{ producto_id: cable, cantidad: 20 },
                           { producto_id: cable, cantidad: 20 }] });
    comp('20 + 20 con 30 en el estante se niega', dosLineas.status === 400,
      dosLineas.status + ' ' + JSON.stringify(dosLineas.cuerpo));
    comp('y el cartel suma las dos: 40', /sacando 40/.test(dosLineas.cuerpo.error || ''),
      dosLineas.cuerpo.error);
    const bueno = await post('/api/traslados', { origen_id: tienda, destino_id: almacen,
      fecha: hoy, lineas: [{ producto_id: cable, cantidad: 10 },
                           { producto_id: cable, cantidad: 20 }] });
    comp('10 + 20, que son justo los 30, sí sale', bueno.status === 200,
      JSON.stringify(bueno.cuerpo));
    comp('y la tienda se queda sin cable', !(await stockDe(tienda))[cable],
      (await stockDe(tienda))[cable]);

    console.log('\n=== La venta sigue frenada, y con el mismo cartel ===');
    await post('/api/movimientos', { tipo: 'compra', sitio_id: tienda, producto_id: panel,
      cantidad: 2, costo_unit: 14000 });
    const venta = await post('/api/ventas', { sitio_id: tienda, moneda: 'CUP',
      lineas: [{ producto_id: panel, cantidad: 3 }] });
    comp('vender 3 con 2 en el estante se niega', venta.status === 400,
      venta.status + ' ' + JSON.stringify(venta.cuerpo));
    // El mismo producto en dos líneas: por separado cada una cabe. Antes esto lo
    // llevaba una cuenta aparte dentro del bucle de la venta; ahora es el mismo
    // guardián que usa todo lo demás, y hay que ver que sigue agrupando.
    const dosVeces = await post('/api/ventas', { sitio_id: tienda, moneda: 'CUP',
      lineas: [{ producto_id: panel, cantidad: 2 }, { producto_id: panel, cantidad: 2 }] });
    comp('2 + 2 del mismo panel con 2 en el estante también se niega',
      dosVeces.status === 400, dosVeces.status + ' ' + JSON.stringify(dosVeces.cuerpo));
    comp('y no se coló ninguna de las dos ventas',
      casi((await stockDe(tienda))[panel], 2), (await stockDe(tienda))[panel]);
    comp('vender los 2 que hay sí se puede',
      (await post('/api/ventas', { sitio_id: tienda, moneda: 'CUP',
        lineas: [{ producto_id: panel, cantidad: 2 }] })).status === 200);

    console.log('\n=== Contar no puede dar menos que nada ===');
    const cierreMal = await post('/api/dias/cerrar', { sitio_id: tienda, fecha: hoy,
      ajustar: true, conteos: [{ producto_id: panel, contado: -2 }] });
    comp('cerrar el día con un conteo en negativo se niega', cierreMal.status === 400,
      cierreMal.status + ' ' + JSON.stringify(cierreMal.cuerpo));
    comp('y dice de qué producto es', /Panel 450W/.test(cierreMal.cuerpo.error || ''),
      cierreMal.cuerpo.error);
    comp('el día NO se quedó cerrado',
      (await post('/api/movimientos', { tipo: 'compra', sitio_id: tienda,
        producto_id: panel, cantidad: 1, costo_unit: 14000 })).status === 200);

    console.log('\n=== Cancelar una inversión cuya mercancía ya se vendió ===');
    // La cancelación mete el movimiento contrario de cada entrada. Si lo comprado
    // ya salió, ese contrario deja el estante debiendo unidades.
    await post('/api/fondo', { tipo: 'ingreso', subtipo: 'Aporte de socio', moneda: 'CUP',
      importe: 500000, sitio_id: almacen, concepto: 'Capital', fecha: hoy });
    const inv = await post('/api/inversiones', { nombre: 'Compra de cable', moneda: 'CUP',
      fecha: hoy, sitio_id: almacen,
      lineas: [{ producto_id: cable, cantidad: 20, costo_unit: 60,
                 reparto: [{ sitio_id: almacen, cantidad: 20 }] }] });
    comp('la inversión se guarda', inv.status === 200, JSON.stringify(inv.cuerpo).slice(0, 200));
    const reg = await post('/api/inversiones/' + inv.cuerpo.id + '/registrar', {});
    comp('y se registra, con el cable entrando al almacén', reg.status === 200,
      JSON.stringify(reg.cuerpo).slice(0, 200));
    comp('el almacén tiene los 20 metros', casi((await stockDe(almacen))[cable], 20),
      (await stockDe(almacen))[cable]);
    await post('/api/ventas', { sitio_id: almacen, moneda: 'CUP',
      lineas: [{ producto_id: cable, cantidad: 15 }] });
    comp('se venden 15 y quedan 5', casi((await stockDe(almacen))[cable], 5),
      (await stockDe(almacen))[cable]);
    const canc = await post('/api/inversiones/' + inv.cuerpo.id + '/cancelar', {});
    comp('cancelarla entera se niega, porque esa mercancía ya no está',
      canc.status === 400, canc.status + ' ' + JSON.stringify(canc.cuerpo));
    comp('el almacén conserva sus 5 metros', casi((await stockDe(almacen))[cable], 5),
      (await stockDe(almacen))[cable]);
    comp('y la inversión sigue registrada, no a medio cancelar',
      (await pedir('/api/inversiones/' + inv.cuerpo.id)).cuerpo.inversion.estado === 'registrada',
      (await pedir('/api/inversiones/' + inv.cuerpo.id)).cuerpo.inversion.estado);

    console.log('\n=== Y el guardián está en UNA función, no en cinco copias ===');
    // La lección de la #38: la vez que un criterio así se escribió dos veces, una
    // de las copias se quedó sin él. La prueba lee el archivo con los comentarios
    // dentro, así que se busca la llamada, no la palabra.
    const servidor = fs.readFileSync(path.join(raiz, 'server.js'), 'utf8');
    comp('existe una sola función que lo decide',
      (servidor.match(/^function queFalta\(/gm) || []).length === 1);
    comp('y la usan la venta, la merma, el despacho y la inversión',
      (servidor.match(/faltaMercancia\(/g) || []).length >= 5,
      (servidor.match(/faltaMercancia\(/g) || []).length);
    comp('la pantalla enseña lo que hay antes de teclear la cantidad',
      /function alPonerCantMov/.test(fs.readFileSync(path.join(raiz, 'public/app.js'), 'utf8')));

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
