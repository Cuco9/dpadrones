// Las dos monedas, medidas sin mezclarlas nunca; y el dinero de cada gaveta.
//
// El dueño lo dijo el 14 de agosto de 2026: el negocio se mide en DÓLARES, y
// pesos y dólares no se suman jamás —se enseña uno y el otro al lado, para
// saber de cuánto se habla—. Aquí se comprueba justo eso, que es lo que ninguna
// prueba miraba y por donde se colaron dos fallos:
//
//   · las comisiones sumaban con SQL el total de todas las ventas, y ahí caían
//     juntas las de pesos y las de dólares;
//   · el costo de un producto se guardaba SIEMPRE convertido a pesos, midiera
//     el negocio en lo que midiera.
//
// Y lo nuevo: cada sitio tiene su gaveta y se puede pasar dinero de una a otra.
//
//   node pruebas/monedas.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const raiz = path.join(__dirname, '..');
const patio = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-mon-'));

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
const hoy = new Date().toLocaleDateString('sv-SE');

(async () => {
  try {
    const PUERTO = await puertoLibre();
    BASE = 'http://127.0.0.1:' + PUERTO;
    await arrancar({ PUERTO, DP_DB: path.join(patio, 'app.db'), DP_HTTP: '1' },
                   /D´Padrones/);

    console.log('\n=== Preparar: administrador, tres sitios y el dólar puesto ===');
    await post('/api/auth/crear-admin', { nombre: 'Jefe', usuario: 'jefe', pin: '1234' });
    const ses = await post('/api/auth/entrar', { usuario: 'jefe', pin: '1234' });
    cab = { Authorization: 'Bearer ' + ses.cuerpo.token };
    await post('/api/tasa', { tasa: 400 });
    const almacen = (await pedir('/api/sitios')).cuerpo[0].id;
    const centro = (await post('/api/sitios',
      { nombre: 'Punto Centro', tipo: 'punto', padre_id: almacen })).cuerpo.id;
    const playa = (await post('/api/sitios',
      { nombre: 'Punto Playa', tipo: 'punto', padre_id: almacen })).cuerpo.id;
    comp('los tres sitios están', !!(almacen && centro && playa));

    console.log('\n=== El negocio se mide en dólares ===');
    // Se crea todo con el negocio ya medido en dólares, que es lo que pidió el
    // dueño: aquí se compra en dólares y el peso se devalúa por debajo.
    const cambio = await post('/api/moneda-base', { moneda: 'USD', tasa: 400 });
    comp('se puede pasar la medida del negocio a dólares', cambio.status === 200,
      JSON.stringify(cambio.cuerpo));
    comp('y queda apuntado que es USD',
      (await pedir('/api/tasa')).cuerpo.moneda_base === 'USD');

    // Costo 300 USD, precio 500 USD. Con el negocio medido en dólares, ese 300
    // se guarda TAL CUAL: es el número que el servidor va a restar del ingreso.
    const panel = await post('/api/productos', { nombre: 'Panel 450W', precio: 500,
      precio_moneda: 'USD', costo: 300, um: 'Unidad' });
    const idPanel = panel.cuerpo.id;
    const cable = await post('/api/productos', { nombre: 'Cable 10mm', precio: 2,
      precio_moneda: 'USD', costo: 1, um: 'Metro' });
    const idCable = cable.cuerpo.id;
    comp('la unidad de medida se guarda tal como se pidió',
      (await pedir('/api/productos')).cuerpo.productos.find(p => p.id === idCable).um === 'Metro');

    await post('/api/movimientos', { tipo: 'compra', sitio_id: centro, producto_id: idPanel,
      cantidad: 10, costo_unit: 300 });
    await post('/api/movimientos', { tipo: 'compra', sitio_id: centro, producto_id: idCable,
      cantidad: 500, costo_unit: 1 });

    console.log('\n=== Una venta en dólares y otra en pesos, sin mezclarlas ===');
    // 1 panel a 500 USD.
    const v1 = await post('/api/ventas', { sitio_id: centro, moneda: 'USD',
      lineas: [{ producto_id: idPanel, cantidad: 1 }] });
    comp('la venta en dólares entra', v1.status === 200, JSON.stringify(v1.cuerpo));
    // 100 metros de cable cobrados en PESOS: 100 × 2 USD × 400 = 80 000 CUP.
    const v2 = await post('/api/ventas', { sitio_id: centro, moneda: 'CUP',
      lineas: [{ producto_id: idCable, cantidad: 100 }] });
    comp('la venta en pesos entra', v2.status === 200, JSON.stringify(v2.cuerpo));
    comp('y se cobró en pesos al cambio del día', v2.cuerpo.total === 80000, v2.cuerpo.total);

    const dia = await pedir('/api/dia?sitio_id=' + centro + '&fecha=' + hoy);
    const c = dia.cuerpo.ventas;
    comp('la jornada se mide en dólares', c.moneda_base === 'USD', c.moneda_base);
    // 500 (el panel) + 200 (el cable, que son 80 000 pesos a 400) = 700.
    comp('lo vendido son 700 USD y no una suma de pesos con dólares',
      c.total === 700, c.total);
    // Costo: 300 del panel + 100 del cable = 400. Ganancia 300.
    comp('el costo sale en dólares, no en pesos', c.costo === 400, c.costo);
    comp('y la ganancia es 300 USD', c.ganancia === 300, c.ganancia);
    comp('el efectivo sí va separado por moneda',
      c.por_moneda.USD === 500 && c.por_moneda.CUP === 80000,
      JSON.stringify(c.por_moneda));

    console.log('\n=== La comisión de cada uno, en la moneda en que se le paga ===');
    const com = await pedir('/api/comisiones?desde=' + hoy + '&hasta=' + hoy);
    const jefe = com.cuerpo.comisiones[0];
    comp('el vendido de cada persona también está en dólares',
      jefe && jefe.vendido === 700, jefe && jefe.vendido);
    comp('la lista dice en qué se mide', com.cuerpo.moneda_base === 'USD');
    comp('sin elegir nada, se le paga en la moneda del negocio',
      jefe.moneda_pago === 'USD', jefe.moneda_pago);

    // Ahora el dueño dice que a esta persona se le paga en pesos.
    const yo = (await pedir('/api/cargos')).cuerpo.personas[0];
    await post('/api/personas', { id: yo.id, nombre: yo.nombre, usuario: yo.usuario,
      cargo_id: yo.cargo_id, moneda_pago: 'CUP' });
    const com2 = await pedir('/api/comisiones?desde=' + hoy + '&hasta=' + hoy);
    const j2 = com2.cuerpo.comisiones[0];
    comp('se puede decir que a esa persona se le paga en pesos', j2.moneda_pago === 'CUP',
      j2.moneda_pago);
    comp('la comisión se sigue MIDIENDO en dólares', j2.comision === jefe.comision,
      j2.comision + ' vs ' + jefe.comision);
    comp('y lo que hay que darle sale en pesos, al cambio',
      j2.a_pagar === Math.round(j2.comision * 400), j2.a_pagar + ' / ' + j2.comision);

    console.log('\n=== Cada sitio tiene su gaveta ===');
    const f1 = await pedir('/api/fondo?desde=' + hoy + '&hasta=' + hoy + '&sitio=' + centro);
    comp('la gaveta del Centro tiene lo que se cobró allí',
      f1.cuerpo.saldo_sitio.USD === 500 && f1.cuerpo.saldo_sitio.CUP === 80000,
      JSON.stringify(f1.cuerpo.saldo_sitio));
    comp('y la de Playa está vacía',
      (await pedir('/api/fondo?sitio=' + playa)).cuerpo.saldo_sitio.CUP === 0);
    comp('el fondo general es la suma de todas',
      f1.cuerpo.saldo.USD === 500 && f1.cuerpo.saldo.CUP === 80000,
      JSON.stringify(f1.cuerpo.saldo));

    console.log('\n=== Pasar dinero de una gaveta a otra ===');
    const tr = await post('/api/fondo/traspaso', { origen_id: centro, destino_id: playa,
      moneda: 'CUP', importe: 30000, concepto: 'Para el vuelto' });
    comp('el traspaso se apunta', tr.status === 200, JSON.stringify(tr.cuerpo));
    comp('sale de donde estaba', tr.cuerpo.origen.CUP === 50000, tr.cuerpo.origen.CUP);
    comp('y entra donde va', tr.cuerpo.destino.CUP === 30000, tr.cuerpo.destino.CUP);

    const f2 = await pedir('/api/fondo?desde=' + hoy + '&hasta=' + hoy);
    comp('el negocio sigue teniendo el mismo dinero: no salió, cambió de sitio',
      f2.cuerpo.saldo.CUP === 80000, f2.cuerpo.saldo.CUP);
    // Lo importante: un traspaso NO es un ingreso ni un retiro del negocio. Si
    // contara, el resumen del mes diría que entraron 30 000 que no entraron.
    comp('no se cuenta como dinero que entra', f2.cuerpo.resumen.CUP.ingreso === 80000,
      f2.cuerpo.resumen.CUP.ingreso);
    comp('ni como dinero que sale', f2.cuerpo.resumen.CUP.retiro === 0,
      f2.cuerpo.resumen.CUP.retiro);
    comp('el traspaso deja sus dos mitades a la vista',
      f2.cuerpo.movimientos.filter(m => m.ref_tipo === 'traspaso').length === 2);

    console.log('\n=== Lo que no se puede hacer con un traspaso ===');
    const dema = await post('/api/fondo/traspaso', { origen_id: playa, destino_id: centro,
      moneda: 'CUP', importe: 999999 });
    comp('sacar más de lo que hay se rechaza', dema.status === 400, dema.status);
    comp('y dice cuánto hay de verdad', /30\s?000/.test(dema.cuerpo.error || ''),
      dema.cuerpo.error);
    const mismo = await post('/api/fondo/traspaso', { origen_id: centro, destino_id: centro,
      moneda: 'CUP', importe: 10 });
    comp('pasarse dinero a uno mismo no vale', mismo.status === 400);
    const cero = await post('/api/fondo/traspaso', { origen_id: centro, destino_id: playa,
      moneda: 'CUP', importe: 0 });
    comp('un importe de cero tampoco', cero.status === 400);
    const inventado = await post('/api/fondo/traspaso', { origen_id: centro,
      destino_id: 'no-existe', moneda: 'CUP', importe: 10 });
    comp('ni a un sitio que no existe', inventado.status === 400);

    console.log('\n=== Cada apunte dice de dónde salió ===');
    // Antes, en la lista ponía «Venta · 1 500 CUP» y para saber qué venta era
    // había que ir a Cierre, poner la fecha buena, elegir el sitio bueno y
    // buscarla a ojo entre las del día.
    const movs = (await pedir('/api/fondo?desde=' + hoy + '&hasta=' + hoy)).cuerpo.movimientos;
    const deVenta = movs.find(m => m.ref_tipo === 'venta');
    const org = await pedir('/api/fondo/' + deVenta.id);
    comp('un apunte de venta lleva a su venta', org.cuerpo.origen &&
      org.cuerpo.origen.tipo === 'venta', JSON.stringify(org.cuerpo.origen || {}).slice(0, 120));
    comp('con lo que se vendió dentro', org.cuerpo.origen.lineas.length > 0,
      JSON.stringify(org.cuerpo.origen.lineas || []).slice(0, 120));
    comp('y dice dónde y quién la hizo',
      org.cuerpo.origen.venta.sitio === 'Punto Centro' && org.cuerpo.origen.venta.persona === 'Jefe',
      org.cuerpo.origen.venta.sitio + ' / ' + org.cuerpo.origen.venta.persona);

    const deTraspaso = movs.find(m => m.ref_tipo === 'traspaso');
    const org2 = await pedir('/api/fondo/' + deTraspaso.id);
    comp('un traspaso enseña sus DOS mitades', org2.cuerpo.origen &&
      org2.cuerpo.origen.mitades.length === 2,
      JSON.stringify(org2.cuerpo.origen || {}).slice(0, 160));
    comp('una de salida y otra de entrada',
      org2.cuerpo.origen.mitades.some(m => m.tipo === 'ingreso') &&
      org2.cuerpo.origen.mitades.some(m => m.tipo === 'retiro'));

    const apunteInventado = await pedir('/api/fondo/no-existe');
    comp('un apunte que no existe da 404', apunteInventado.status === 404);

    // Y la venta suelta, que hace falta para poder mirarla sin cargar el día
    // entero del sitio en el que se hizo.
    const laVenta = await pedir('/api/ventas/' + deVenta.ref_id);
    comp('una venta se puede pedir por su id', laVenta.status === 200 &&
      laVenta.cuerpo.venta.id === deVenta.ref_id, laVenta.status);

    console.log('\n=== El desglose de cada gaveta ===');
    // Lo que pidió el dueño: los mismos conceptos de la tarjeta del negocio,
    // pero de cada tienda y de cada almacén.
    const desglose = (await pedir('/api/negocio?desde=' + hoy + '&hasta=' + hoy)).cuerpo;
    const elCentro = desglose.sitios.find(p => p.sitio === 'Punto Centro');
    const laPlaya = desglose.sitios.find(p => p.sitio === 'Punto Playa');
    comp('cada sitio trae los conceptos del período por moneda',
      ['ingreso', 'retiro', 'inversion', 'gasto', 'recibido', 'mandado']
        .every(t => typeof elCentro.fondo.CUP[t] === 'number'),
      JSON.stringify(elCentro.fondo.CUP));
    comp('el Centro cobró 80 000 pesos de ventas', elCentro.fondo.CUP.ingreso === 80000,
      elCentro.fondo.CUP.ingreso);
    // «Entró 80 000» no dice si fue del mostrador o de un apunte a mano.
    comp('y se sabe que entraron VENDIENDO, no por otra cosa',
      elCentro.fondo.CUP.de_ventas === 80000,
      JSON.stringify({ v: elCentro.fondo.CUP.de_ventas }));
    comp('lo de las dos procedencias suma lo que entró',
      elCentro.fondo.USD.de_ventas + elCentro.fondo.USD.de_otros ===
        elCentro.fondo.USD.ingreso,
      JSON.stringify(elCentro.fondo.USD));
    // Lo importante: un traspaso NO puede aparecer como ingreso de la tienda
    // que lo recibe, o parecería que vendió 30 000 más de lo que vendió.
    comp('lo que le pasaron a Playa no cuenta como que Playa ingresó',
      laPlaya.fondo.CUP.ingreso === 0, laPlaya.fondo.CUP.ingreso);
    comp('sale en su propia casilla', laPlaya.fondo.CUP.recibido === 30000,
      laPlaya.fondo.CUP.recibido);
    comp('y en el Centro, como dinero mandado', elCentro.fondo.CUP.mandado === 30000,
      elCentro.fondo.CUP.mandado);
    const quedo = p => p.fondo.CUP.ingreso + p.fondo.CUP.recibido -
      p.fondo.CUP.retiro - p.fondo.CUP.inversion - p.fondo.CUP.gasto - p.fondo.CUP.mandado;
    comp('lo que quedó en cada uno cuadra con su gaveta',
      quedo(elCentro) === elCentro.gaveta.CUP && quedo(laPlaya) === laPlaya.gaveta.CUP,
      quedo(elCentro) + '/' + elCentro.gaveta.CUP + ' · ' + quedo(laPlaya) + '/' + laPlaya.gaveta.CUP);
    // En el total del negocio los traspasos se compensan: sale de uno, entra
    // en otro, y el negocio no tiene ni un peso más ni uno menos.
    comp('en el total del negocio los traspasos se compensan',
      desglose.total.fondo.CUP.recibido === desglose.total.fondo.CUP.mandado,
      desglose.total.fondo.CUP.recibido + ' vs ' + desglose.total.fondo.CUP.mandado);

    console.log('\n=== Y las gavetas siguen cuadrando con el mirador ===');
    const neg = await pedir('/api/negocio?desde=' + hoy + '&hasta=' + hoy);
    const gav = neg.cuerpo.sitios.reduce((s, p) => s + (p.gaveta ? p.gaveta.CUP : 0), 0);
    comp('la suma de las gavetas es el fondo general', gav === 80000, gav);

    console.log('\n=== Cambiar el PIN echa a ese dispositivo ===');
    // El PIN se cambia justo cuando se ha sabido: alguien lo vio, o el teléfono
    // se perdió. La sesión ya no mira el PIN, así que sin esto ese teléfono
    // seguía dentro para siempre.
    await post('/api/personas', { nombre: 'Rosa', usuario: 'rosa', pin: '5555' });
    const suyaAntes = await post('/api/auth/entrar', { usuario: 'rosa', pin: '5555' });
    const suCab = { Authorization: 'Bearer ' + suyaAntes.cuerpo.token };
    comp('la trabajadora entra con su usuario y su PIN', suyaAntes.status === 200,
      suyaAntes.status);
    comp('y su sesión vale', (await pedir('/api/auth/yo', { headers: suCab })).status === 200);
    const laRosa = (await pedir('/api/cargos')).cuerpo.personas.find(p => p.usuario === 'rosa');
    await post('/api/personas', { id: laRosa.id, nombre: 'Rosa', usuario: 'rosa', pin: '6666' });
    comp('al cambiarle el PIN, su sesión deja de valer',
      (await pedir('/api/auth/yo', { headers: suCab })).status === 401);
    // Y desactivarla corta igual de rápido, aunque su teléfono estuviera dentro.
    const otraVez = await post('/api/auth/entrar', { usuario: 'rosa', pin: '6666' });
    const suCab2 = { Authorization: 'Bearer ' + otraVez.cuerpo.token };
    await post('/api/personas', { id: laRosa.id, nombre: 'Rosa', usuario: 'rosa',
      activo: false });
    comp('y desactivarla la echa aunque tuviera el teléfono dentro',
      (await pedir('/api/auth/yo', { headers: suCab2 })).status === 401);

    console.log('\n=== Borrar datos: lo que se lleva por delante y lo que no ===');
    // Va AL FINAL a propósito: deja la base vacía.
    const previa = await pedir('/api/borrar/vista-previa');
    comp('se puede ver cuánto hay de cada cosa antes de borrar', previa.status === 200,
      JSON.stringify(previa.cuerpo).slice(0, 120));
    const cuenta = id => (previa.cuerpo.grupos.find(g => g.id === id) || {}).cuantos;
    comp('y dice que hay ventas que borrar', cuenta('ventas') > 0, cuenta('ventas'));

    const sinPalabra = await post('/api/borrar', { grupos: ['ventas'] });
    comp('sin escribir BORRAR no se borra nada', sinPalabra.status === 400, sinPalabra.status);
    const sinNada = await post('/api/borrar', { grupos: [], confirmacion: 'BORRAR' });
    comp('sin elegir nada tampoco', sinNada.status === 400);
    // Borrar los productos dejando las ventas dejaría apuntes de algo que ya no
    // existe. Se comprueba en el SERVIDOR, no solo en la pantalla.
    const suelto = await post('/api/borrar', { grupos: ['catalogo'], confirmacion: 'BORRAR' });
    comp('el catálogo no se borra solo: arrastra lo que lo nombra', suelto.status === 400,
      suelto.cuerpo.error);
    comp('y dice qué más hay que borrar', /Ventas/.test(suelto.cuerpo.error || ''),
      suelto.cuerpo.error);

    // Quien no es administrador no puede, aunque lo pida por su cuenta.
    const cargoCiego = await post('/api/cargos', { nombre: 'Casi todo',
      permisos: ['vender', 'gestionar_dinero', 'ver_ganancias', 'gestionar_productos'] });
    await post('/api/personas', { nombre: 'Encargado', usuario: 'encargado', pin: '4321',
      cargo_id: cargoCiego.cuerpo.id });
    const suya = await post('/api/auth/entrar', { usuario: 'encargado', pin: '4321' });
    const guardado = cab;
    cab = { Authorization: 'Bearer ' + suya.cuerpo.token };
    const ajeno = await post('/api/borrar', { grupos: ['ventas'], confirmacion: 'BORRAR' });
    comp('quien no es administrador no puede borrar', ajeno.status === 403, ajeno.status);
    comp('ni siquiera puede mirar cuánto hay',
      (await pedir('/api/borrar/vista-previa')).status === 403);
    cab = guardado;

    // Y ahora sí: se borran las ventas y se comprueba que el catálogo sigue.
    const hecho = await post('/api/borrar', { grupos: ['ventas'], confirmacion: 'borrar' });
    comp('el administrador sí puede, y vale en minúsculas', hecho.status === 200,
      JSON.stringify(hecho.cuerpo).slice(0, 140));
    comp('se hace una copia de seguridad antes, y se dice cuál',
      /^dp-\d{8}-\d{4}\.db$/.test(hecho.cuerpo.copia || ''), hecho.cuerpo.copia);
    comp('ya no queda ninguna venta',
      (await pedir('/api/dia?sitio_id=' + centro + '&fecha=' + hoy)).cuerpo.ventas.cuenta === 0);
    const quedaStock = (await pedir('/api/stock?sitio_id=' + centro)).cuerpo.stock || {};
    comp('el inventario queda en cero',
      Object.values(quedaStock).every(v => !v), JSON.stringify(quedaStock));
    comp('pero los productos siguen ahí',
      (await pedir('/api/productos')).cuerpo.productos.length === 2);
    const saldoTras = (await pedir('/api/fondo')).cuerpo.saldo;
    comp('y las gavetas quedan vacías', saldoTras.CUP === 0 && saldoTras.USD === 0,
      JSON.stringify(saldoTras));
    // Sin esto no se puede ni entrar a la aplicación, y quien quiere empezar de
    // cero quiere empezar a vender, no a configurar.
    const quedan = (await pedir('/api/cargos')).cuerpo.personas.length;
    comp('los sitios y el personal no se tocan',
      (await pedir('/api/sitios')).cuerpo.length === 3 && quedan === 3, quedan);

    console.log('\n=== Repasar los costos que quedaron mal escritos ===');
    // Se reproduce el accidente del 12 al 14 de agosto de 2026: el costo tecleado
    // en dólares y guardado convertido a pesos, con el negocio medido en dólares.
    // 300 se convirtió en 120 000, y el servidor lo lee como 120 000 USD.
    const roto = await post('/api/productos', { nombre: 'Inversor 5kW', precio: 600,
      precio_moneda: 'USD', costo: 120000, um: 'Unidad' });
    const idRoto = roto.cuerpo.id;
    // Dinero en la caja del centro para poder comprar: no se saca de una gaveta lo
    // que no tiene dentro (DECISIONES.md #38). El borrado de arriba dejó el fondo
    // en cero, así que hay que ponerlo aquí y no antes.
    await post('/api/fondo', { tipo: 'ingreso', subtipo: 'Aporte de socio', moneda: 'USD',
      importe: 5000, sitio_id: centro, concepto: 'Capital para el contenedor' });
    // La inversión es la PRUEBA de lo que costó de verdad: salió de una factura.
    const compra = await post('/api/inversiones', { nombre: 'Contenedor', moneda: 'USD',
      fecha: hoy, sitio_id: centro,
      lineas: [{ producto_id: idRoto, cantidad: 4, costo_unit: 300,
        reparto: [{ sitio_id: centro, cantidad: 4 }] }] });
    await post('/api/inversiones/' + compra.cuerpo.id + '/registrar', {});
    // Y una entrada y una venta hechas con el costo malo, que es lo que arrastra
    // la ganancia en negativo.
    await post('/api/movimientos', { tipo: 'compra', sitio_id: centro, producto_id: idRoto,
      cantidad: 5, costo_unit: 120000 });
    const ventaMala = await post('/api/ventas', { sitio_id: centro, moneda: 'USD',
      lineas: [{ producto_id: idRoto, cantidad: 1 }] });
    comp('la venta con el costo malo entra igual', ventaMala.status === 200,
      JSON.stringify(ventaMala.cuerpo).slice(0, 120));
    const antesVenta = await pedir('/api/ventas/' + ventaMala.cuerpo.id);
    comp('y deja un costo absurdo apuntado: 120 000 USD por vender 600',
      antesVenta.cuerpo.venta.costo_total === 120000, antesVenta.cuerpo.venta.costo_total);

    const repaso = await pedir('/api/costos/repasar');
    const mio = (repaso.cuerpo.productos || []).find(p => p.id === idRoto);
    comp('el repaso lo encuentra', !!mio, JSON.stringify(repaso.cuerpo).slice(0, 160));
    comp('y dice cuántas veces se pasa', mio && mio.veces === 200, mio && mio.veces);
    comp('propone lo que costó según la inversión, no un número inventado',
      mio && mio.propuesto === 300 && mio.de_donde === 'inversion',
      mio && mio.propuesto + ' / ' + mio.de_donde);
    comp('y ofrece también deshacer la conversión de más',
      mio && mio.opciones.some(o => o.de === 'deshacer' && o.costo === 300),
      mio && JSON.stringify(mio.opciones));
    comp('avisa de lo que arrastra ese costo',
      mio && mio.arrastre.movimientos >= 2 && mio.arrastre.ventas === 1,
      mio && JSON.stringify(mio.arrastre));
    // Un producto sano no sale: si saliera todo el catálogo, nadie miraría.
    comp('el panel, que está bien, no aparece en la lista',
      !(repaso.cuerpo.productos || []).some(p => p.id === idPanel));

    const sinDecirlo = await post('/api/costos/corregir', {
      correcciones: [{ producto_id: idRoto, costo: 300 }] });
    comp('sin escribir CORREGIR no se toca nada', sinDecirlo.status === 400, sinDecirlo.status);
    const enCero = await post('/api/costos/corregir', { confirmacion: 'CORREGIR',
      correcciones: [{ producto_id: idRoto, costo: 0 }] });
    comp('ni con un costo de cero', enCero.status === 400, JSON.stringify(enCero.cuerpo));

    const arreglo = await post('/api/costos/corregir', { confirmacion: 'corregir',
      correcciones: [{ producto_id: idRoto, costo: 300 }] });
    comp('se corrige, y la palabra vale en minúsculas', arreglo.status === 200,
      JSON.stringify(arreglo.cuerpo).slice(0, 160));
    comp('se hace una copia de seguridad antes, y se dice cuál',
      /^dp-\d{8}-\d{4}\.db$/.test(arreglo.cuerpo.copia || ''), arreglo.cuerpo.copia);
    comp('el catálogo queda con el costo bueno',
      (await pedir('/api/productos')).cuerpo.productos.find(p => p.id === idRoto).costo === 300);
    comp('los apuntes del inventario que lo llevaban, también',
      arreglo.cuerpo.hecho.movimientos >= 2, JSON.stringify(arreglo.cuerpo.hecho));
    const trasVenta = await pedir('/api/ventas/' + ventaMala.cuerpo.id);
    comp('y la venta deja de costar más de lo que se cobró',
      trasVenta.cuerpo.venta.costo_total === 300, trasVenta.cuerpo.venta.costo_total);
    comp('ya no queda ningún costo raro que repasar',
      !((await pedir('/api/costos/repasar')).cuerpo.productos || []).some(p => p.id === idRoto));
    // Los apuntes de la inversión valían 300 desde el principio: corregir el
    // producto NO puede haberlos tocado, o el día que un producto entre dos veces
    // a precios distintos se perdería el segundo.
    const inv = await pedir('/api/inversiones/' + compra.cuerpo.id);
    comp('lo que ya estaba bien no se toca', inv.cuerpo.importe === 1200,
      inv.cuerpo.importe);

  } catch (e) {
    mal++;
    console.log('\n  MAL  la prueba se rompió: ' + e.message + '\n' + e.stack);
  } finally {
    cerrarTodo();
    try { fs.rmSync(patio, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n' + (mal ? 'FALLAN ' + mal + ' de ' + (ok + mal) : 'TODO BIEN: ' + ok + ' comprobaciones'));
  process.exit(mal ? 1 : 0);
})();
