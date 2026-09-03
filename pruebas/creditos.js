// LO QUE SE FÍA: ventas a clientes, cobros a plazos y lo que queda por cobrar.
//
// Pedido por el dueño el 3 de septiembre de 2026: «poder crear ventas y
// enlazarlas a clientes de forma opcional; a veces el cliente obtiene la
// mercancía pero queda una cuenta por pagar y la paga luego, a veces la paga de
// forma completa o a veces va pagando poco a poco, y necesito saber de lo que
// pagué cuánto le va faltando por pagar».
//
// Lo que se comprueba aquí es lo que puede salir mal sin que se note, que en el
// dinero es casi todo:
//
//   · que la venta de mostrador de siempre NO cambie: se cobra entera, el dinero
//     entra en la caja y la venta queda «cobrada»;
//   · que lo fiado NO meta un peso en ninguna caja —la mercancía sale, el dinero
//     no entra— y que el CUADRE DE LA NOCHE no lo espere: es el fallo que daría
//     un descuadre falso todos los días;
//   · que no se pueda fiar sin decir a quién: una deuda sin cliente no se le
//     puede cobrar a nadie;
//   · que pagando a plazos la cuenta cuadre al céntimo y no se pueda cobrar de
//     más;
//   · que anular una venta fiada devuelva SOLO lo que se cobró, y no su total,
//     que sacaría de la gaveta un dinero que nunca entró;
//   · y que un cobro mal apuntado se pueda deshacer dejando la deuda como estaba.
//
//   node pruebas/creditos.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const raiz = path.join(__dirname, '..');
const patio = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-cre-'));

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

// Sembrar sin mirar si entró es sembrar a ciegas, y una prueba que siembra a
// ciegas miente. Todo lo que prepara el terreno pasa por aquí y revienta si el
// servidor dijo que no.
async function debe(ruta, cuerpo, queEs) {
  const r = await post(ruta, cuerpo);
  if (r.status !== 200) throw new Error('no se pudo sembrar ' + queEs + ': ' +
    r.status + ' ' + JSON.stringify(r.cuerpo));
  return r.cuerpo;
}

const stockDe = async sitio =>
  (await pedir('/api/stock?sitio_id=' + encodeURIComponent(sitio))).cuerpo.stock || {};
const saldoDe = async () => (await pedir('/api/fondo')).cuerpo.saldo;
const laVenta = async id => (await pedir('/api/ventas/' + id)).cuerpo;

(async () => {
  try {
    const PUERTO = await puertoLibre();
    BASE = 'http://127.0.0.1:' + PUERTO;
    await arrancar({ PUERTO, DP_DB: path.join(patio, 'app.db'), DP_HTTP: '1' },
                   /D´Padrones/);

    console.log('\n=== Preparar: una tienda con mercancía dentro ===');
    await post('/api/auth/crear-admin', { nombre: 'Jefe', usuario: 'jefe', pin: '1234' });
    const ses = await post('/api/auth/entrar', { usuario: 'jefe', pin: '1234' });
    cab = { Authorization: 'Bearer ' + ses.cuerpo.token };
    await post('/api/tasa', { tasa: 400 });
    const almacen = (await pedir('/api/sitios')).cuerpo[0].id;
    const tienda = (await debe('/api/sitios',
      { nombre: 'Tienda Centro', tipo: 'punto', padre_id: almacen }, 'la tienda')).id;

    const cemento = (await debe('/api/productos', { nombre: 'Cemento', precio: 1000,
      precio_moneda: 'CUP', costo: 700, um: 'Saco' }, 'el cemento')).id;
    await debe('/api/movimientos', { tipo: 'compra', sitio_id: tienda, producto_id: cemento,
      cantidad: 100, costo_unit: 700 }, 'la entrada de cemento');
    comp('hay 100 sacos en la tienda', (await stockDe(tienda))[cemento] === 100);

    console.log('\n=== La venta de mostrador de siempre NO cambia ===');
    // Es la comprobación que más vale de todas: lo que ya funcionaba tiene que
    // seguir funcionando igual, sin decir nada nuevo.
    const saldo0 = (await saldoDe()).CUP;
    const contado = await debe('/api/ventas', { sitio_id: tienda, moneda: 'CUP',
      lineas: [{ producto_id: cemento, cantidad: 2 }] }, 'la venta al contado');
    comp('la venta entra y se cobra entera', contado.cobrado === 2000 && contado.falta === 0,
      JSON.stringify(contado));
    comp('el dinero entra en la caja en el acto',
      casi((await saldoDe()).CUP, saldo0 + 2000), (await saldoDe()).CUP);
    comp('y la venta queda «cobrada»',
      (await laVenta(contado.id)).venta.estado_cobro === 'cobrada');
    comp('con un solo cobro apuntado', (await laVenta(contado.id)).cobros.length === 1);

    console.log('\n=== No se fía sin decir a quién ===');
    const sinDueno = await post('/api/ventas', { sitio_id: tienda, moneda: 'CUP',
      cobrado_ahora: 0, lineas: [{ producto_id: cemento, cantidad: 1 }] });
    comp('fiar sin cliente se niega', sinDueno.status === 400, sinDueno.status);
    comp('y se dice por qué: no se le puede cobrar a nadie',
      /cliente/i.test(sinDueno.cuerpo.error || ''), sinDueno.cuerpo.error);
    comp('la mercancía no se movió: no quedó media venta escrita',
      (await stockDe(tienda))[cemento] === 98, (await stockDe(tienda))[cemento]);

    const inventado = await post('/api/ventas', { sitio_id: tienda, moneda: 'CUP',
      cobrado_ahora: 0, cliente_id: 'este-cliente-no-existe',
      lineas: [{ producto_id: cemento, cantidad: 1 }] });
    comp('y un cliente inventado tampoco cuela', inventado.status === 400, inventado.status);

    console.log('\n=== Un cliente, y una venta fiada entera ===');
    const juan = (await debe('/api/clientes',
      { nombre: 'Juan Pérez', telefono: '55555555' }, 'el cliente')).id;
    const saldo1 = (await saldoDe()).CUP;
    const fiada = await debe('/api/ventas', { sitio_id: tienda, moneda: 'CUP',
      cliente_id: juan, cobrado_ahora: 0,
      lineas: [{ producto_id: cemento, cantidad: 10 }] }, 'la venta fiada');
    comp('la venta fiada entra', fiada.total === 10000 && fiada.falta === 10000,
      JSON.stringify(fiada));
    // LO IMPORTANTE, y es lo que se rompería sin darse cuenta:
    comp('NO entra un peso en la caja: el cliente no ha pagado',
      casi((await saldoDe()).CUP, saldo1), (await saldoDe()).CUP);
    comp('pero la mercancía SÍ sale: se la llevó',
      (await stockDe(tienda))[cemento] === 88, (await stockDe(tienda))[cemento]);
    comp('la venta queda «pendiente»',
      (await laVenta(fiada.id)).venta.estado_cobro === 'pendiente');
    comp('y sin ningún cobro apuntado', (await laVenta(fiada.id)).cobros.length === 0);

    console.log('\n=== El cuadre de la noche no espera lo que no ha entrado ===');
    // Este es el fallo que daría un descuadre falso todos los días: el efectivo
    // del día tiene que ser lo COBRADO, no lo vendido.
    const dia = (await pedir('/api/dia?sitio_id=' + tienda + '&fecha=' + hoy)).cuerpo;
    comp('el efectivo esperado es solo lo que se cobró de verdad',
      casi(dia.ventas.por_moneda.CUP, 2000), dia.ventas.por_moneda.CUP);
    comp('pero lo VENDIDO del día sí lo cuenta todo: la mercancía salió',
      casi(dia.ventas.total, 12000), dia.ventas.total);
    comp('y se dice cuánto se fió hoy, que es la diferencia entre las dos',
      casi(dia.ventas.fiado, 10000), dia.ventas.fiado);

    console.log('\n=== Va pagando poco a poco ===');
    const saldo2 = (await saldoDe()).CUP;
    const pago1 = await post('/api/ventas/' + fiada.id + '/cobrar', { importe: 3000 });
    comp('trae 3 000 y se apuntan', pago1.status === 200 && pago1.cuerpo.cobrado === 3000,
      JSON.stringify(pago1.cuerpo));
    comp('y le faltan 7 000', pago1.cuerpo.falta === 7000, pago1.cuerpo.falta);
    comp('la venta pasa a «parcial»', pago1.cuerpo.estado_cobro === 'parcial');
    comp('ese dinero SÍ entra en la caja, ahora que está',
      casi((await saldoDe()).CUP, saldo2 + 3000), (await saldoDe()).CUP);

    const pasado = await post('/api/ventas/' + fiada.id + '/cobrar', { importe: 7001 });
    comp('cobrarle más de lo que debe se niega', pasado.status === 400, pasado.status);
    comp('y se dice cuánto falta exactamente',
      /7000/.test(pasado.cuerpo.error || ''), pasado.cuerpo.error);

    await debe('/api/ventas/' + fiada.id + '/cobrar', { importe: 2000 }, 'el segundo pago');
    const trasDos = await laVenta(fiada.id);
    comp('dos pagos suman lo que suman', trasDos.venta.cobrado === 5000, trasDos.venta.cobrado);
    comp('y siguen faltando 5 000', trasDos.venta.falta === 5000, trasDos.venta.falta);
    comp('con los tres apuntes a la vista, no solo el total',
      trasDos.cobros.length === 2, trasDos.cobros.length);

    console.log('\n=== Lo que debe cada cliente ===');
    const porCobrar = (await pedir('/api/por-cobrar')).cuerpo;
    const deJuan = (porCobrar.clientes || []).find(c => c.id === juan);
    comp('Juan sale en la lista de lo que está por cobrar', !!deJuan,
      JSON.stringify((porCobrar.clientes || []).map(c => c.nombre)));
    comp('y debe 5 000', deJuan && casi(deJuan.debe.CUP, 5000), deJuan && deJuan.debe.CUP);
    comp('con la venta de la que viene', deJuan && deJuan.ventas.length === 1);
    comp('el total por cobrar del negocio también', casi(porCobrar.total.CUP, 5000),
      porCobrar.total.CUP);
    const baja = await pedir('/api/clientes/' + juan, { method: 'DELETE' });
    comp('y no se le puede dar de baja mientras deba', baja.status === 400, baja.status);

    console.log('\n=== Paga el resto ===');
    await debe('/api/ventas/' + fiada.id + '/cobrar', { importe: 5000 }, 'el pago final');
    const saldada = await laVenta(fiada.id);
    comp('la venta queda «cobrada»', saldada.venta.estado_cobro === 'cobrada',
      saldada.venta.estado_cobro);
    comp('y no falta nada', saldada.venta.falta === 0, saldada.venta.falta);
    const otraVez = await post('/api/ventas/' + fiada.id + '/cobrar', { importe: 100 });
    comp('cobrarla otra vez se niega', otraVez.status === 400, otraVez.status);
    const yaNoDebe = (await pedir('/api/por-cobrar')).cuerpo;
    comp('y sale de la lista de por cobrar',
      !(yaNoDebe.clientes || []).some(c => c.id === juan));

    console.log('\n=== Se lleva la mercancía y deja una entrega a cuenta ===');
    const saldo3 = (await saldoDe()).CUP;
    const mixta = await debe('/api/ventas', { sitio_id: tienda, moneda: 'CUP',
      cliente_id: juan, cobrado_ahora: 1500,
      lineas: [{ producto_id: cemento, cantidad: 5 }] }, 'la venta con entrega');
    comp('la venta entra con su entrega apuntada',
      mixta.cobrado === 1500 && mixta.falta === 3500, JSON.stringify(mixta));
    comp('en la caja entra solo la entrega',
      casi((await saldoDe()).CUP, saldo3 + 1500), (await saldoDe()).CUP);
    comp('y la venta nace «parcial»',
      (await laVenta(mixta.id)).venta.estado_cobro === 'parcial');

    console.log('\n=== Un cobro mal apuntado se deshace ===');
    const conCobro = await laVenta(mixta.id);
    const saldo4 = (await saldoDe()).CUP;
    const desHecho = await post('/api/cobros/' + conCobro.cobros[0].id + '/anular', {});
    comp('el cobro se anula', desHecho.status === 200, JSON.stringify(desHecho.cuerpo));
    comp('el dinero sale de la caja otra vez',
      casi((await saldoDe()).CUP, saldo4 - 1500), (await saldoDe()).CUP);
    const trasAnular = await laVenta(mixta.id);
    comp('la deuda vuelve entera', trasAnular.venta.falta === 5000, trasAnular.venta.falta);
    comp('y la venta vuelve a «pendiente»', trasAnular.venta.estado_cobro === 'pendiente');
    comp('los dos apuntes se quedan a la vista, el bueno y el que lo deshace',
      trasAnular.cobros.length === 2, trasAnular.cobros.length);
    const dosVeces = await post('/api/cobros/' + conCobro.cobros[0].id + '/anular', {});
    comp('anularlo dos veces se niega', dosVeces.status === 400, dosVeces.status);

    console.log('\n=== Anular una venta fiada devuelve lo COBRADO, no el total ===');
    // Es el error que dejaría la gaveta con menos dinero del que tiene: de una
    // venta fiada que nadie pagó no hay nada que devolver.
    await debe('/api/ventas/' + mixta.id + '/cobrar', { importe: 2000 }, 'un pago antes de anular');
    const saldo5 = (await saldoDe()).CUP;
    const antesStock = (await stockDe(tienda))[cemento];
    await debe('/api/ventas/' + mixta.id + '/anular', {}, 'la anulación');
    comp('de la caja sale solo lo que había entrado: 2 000, no los 5 000',
      casi((await saldoDe()).CUP, saldo5 - 2000), (await saldoDe()).CUP);
    comp('la mercancía vuelve al estante',
      casi((await stockDe(tienda))[cemento], antesStock + 5),
      (await stockDe(tienda))[cemento]);
    const anulada = await laVenta(mixta.id);
    comp('la venta queda anulada', anulada.venta.estado_cobro === 'anulada');
    comp('y no arrastra deuda: sus cobros se deshicieron',
      casi(anulada.venta.cobrado, 0), anulada.venta.cobrado);
    const sinDeuda = (await pedir('/api/por-cobrar')).cuerpo;
    comp('una venta anulada no le queda debiendo a nadie',
      !(sinDeuda.clientes || []).some(c => c.id === juan),
      JSON.stringify((sinDeuda.clientes || []).map(c => c.nombre)));

    console.log('\n=== Fiar es un permiso aparte, y lo guarda el SERVIDOR ===');
    // Esconder el botón es decoración (#10): quien despacha puede vender sin poder
    // decidir a quién se le fía, que es una decisión del dueño y no del mostrador.
    // Se comprueba con un cargo de verdad sin ese permiso, no mirando la pantalla.
    const cargo = await debe('/api/cargos', { nombre: 'Dependiente',
      permisos: ['vender', 'ver_catalogo', 'ver_clientes', 'ver_ventas'] }, 'el cargo');
    await debe('/api/personas', { nombre: 'Ana', usuario: 'ana', pin: '4321',
      cargo_id: cargo.id }, 'la dependienta');
    const jefe = cab;
    const sesAna = await post('/api/auth/entrar', { usuario: 'ana', pin: '4321' });
    cab = { Authorization: 'Bearer ' + sesAna.cuerpo.token };
    const anaFia = await post('/api/ventas', { sitio_id: tienda, moneda: 'CUP',
      cliente_id: juan, cobrado_ahora: 0, lineas: [{ producto_id: cemento, cantidad: 1 }] });
    comp('sin el permiso «fiar», dejar a deber se niega', anaFia.status === 400,
      anaFia.status + ' ' + JSON.stringify(anaFia.cuerpo));
    comp('y se dice qué permiso falta', /permiso/i.test(anaFia.cuerpo.error || ''),
      anaFia.cuerpo.error);
    const anaCobra = await post('/api/ventas', { sitio_id: tienda, moneda: 'CUP',
      lineas: [{ producto_id: cemento, cantidad: 1 }] });
    comp('pero cobrar entero lo sigue pudiendo hacer, como siempre',
      anaCobra.status === 200, JSON.stringify(anaCobra.cuerpo).slice(0, 120));
    cab = jefe;

    console.log('\n=== Con el día cerrado no se cobra ===');
    const paraCerrar = await debe('/api/ventas', { sitio_id: tienda, moneda: 'CUP',
      cliente_id: juan, cobrado_ahora: 0,
      lineas: [{ producto_id: cemento, cantidad: 1 }] }, 'la venta de la jornada');
    await debe('/api/dias/cerrar', { sitio_id: tienda, fecha: hoy, efectivo: 0 }, 'el cierre');
    const tardeMal = await post('/api/ventas/' + paraCerrar.id + '/cobrar', { importe: 500 });
    comp('cobrar en un día cerrado se niega', tardeMal.status === 409, tardeMal.status);
    comp('y se dice que hay que reabrirlo',
      /cerrado/i.test(tardeMal.cuerpo.error || ''), tardeMal.cuerpo.error);

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
