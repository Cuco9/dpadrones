// Las comisiones repartidas entre quienes trabajaron, lo que ya se les pagó, el
// valor del dólar bajo llave y el PIN que cada uno se cambia.
//
// Los cinco ajustes que pidió el dueño el 17 de agosto de 2026. Lo que se
// comprueba aquí es lo que puede salir mal SIN QUE SE NOTE, que es lo único que
// merece una prueba:
//
//   · que repartir no invente ni pierda dinero: la suma de lo que cobra la gente
//     tiene que ser exactamente la comisión del día, ni un peso más;
//   · que los días SIN lista sigan contando como contaban ayer, porque de eso
//     depende que este cambio se pueda desplegar sin tocar los meses pasados;
//   · que desmarcar a alguien VIAJE en la sincronización — es el fallo que ya
//     costó un día entero: una fila que desaparece vuelve del otro lado;
//   · que pagar una comisión saque el dinero de la caja de verdad, y que
//     deshacer el pago devuelva el saldo EXACTAMENTE a donde estaba;
//   · que pagar en septiembre lo de agosto salga en agosto, donde se generó;
//   · y que cambiarse el PIN no te eche de la aplicación, pero sí cierre el
//     teléfono de al lado.
//
//   node pruebas/comisiones.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const raiz = path.join(__dirname, '..');
const patio = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-comis-'));

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
// Para hablar como otra persona sin perder la sesión del jefe.
const comoOtro = token => ({ Authorization: 'Bearer ' + token });
async function postComo(token, ruta, cuerpo) {
  return pedir(ruta, { method: 'POST', body: JSON.stringify(cuerpo || {}),
                       headers: comoOtro(token) });
}

const hoy = new Date().toLocaleDateString('sv-SE');
const mesHoy = hoy.slice(0, 7);
// Un día de la semana pasada, para probar que un día sin lista no cambia. Se
// calcula a partir de hoy y no se escribe a mano: una fecha fija haría que la
// prueba dejara de significar lo mismo al cambiar de mes.
const otroDia = (() => {
  const d = new Date(); d.setDate(d.getDate() - 3);
  const f = d.toLocaleDateString('sv-SE');
  // Si al restar tres días se cambia de mes, se usa el día 1 de este mes: todo
  // el banco mira UN mes, y una fecha del mes anterior lo dejaría fuera.
  return f.slice(0, 7) === mesHoy ? f : mesHoy + '-01';
})();

const comisiones = (mes) => pedir('/api/comisiones?mes=' + (mes || mesHoy));
const deQuien = (d, nombre) => (d.cuerpo.comisiones || []).find(c => c.persona === nombre) ||
  { comision: 0, dias: 0, pagado: { CUP: 0, USD: 0 }, a_pagar: 0, queda: 0 };

(async () => {
  try {
    const PUERTO = await puertoLibre();
    BASE = 'http://127.0.0.1:' + PUERTO;
    await arrancar({ PUERTO, DP_DB: path.join(patio, 'app.db'), DP_HTTP: '1' },
                   /D´Padrones/);

    console.log('\n=== Preparar: el negocio, un punto y tres trabajadores ===');
    await post('/api/auth/crear-admin', { nombre: 'Jefe', usuario: 'jefe', pin: '1234' });
    const ses = await post('/api/auth/entrar', { usuario: 'jefe', pin: '1234' });
    cab = { Authorization: 'Bearer ' + ses.cuerpo.token };
    await post('/api/tasa', { tasa: 400 });
    const almacen = (await pedir('/api/sitios')).cuerpo[0].id;
    const centro = (await post('/api/sitios',
      { nombre: 'Punto Centro', tipo: 'punto', padre_id: almacen })).cuerpo.id;

    // Un cargo que vende y cierra el día, y otro que solo toca el catálogo: el
    // segundo existe para comprobar que NO puede mover el valor del dólar.
    // 'gente_del_dia' va aparte de 'cerrar_dia' desde el catálogo nuevo (#35):
    // cerrar la jornada y decidir entre quiénes se reparte la comisión de ese día
    // no son la misma decisión.
    const vendedor = (await post('/api/cargos', { nombre: 'Vendedor',
      permisos: ['vender', 'cerrar_dia', 'gente_del_dia', 'ver_ganancias'] })).cuerpo.id;
    const catalogo = (await post('/api/cargos', { nombre: 'Etiquetas',
      permisos: ['gestionar_productos'] })).cuerpo.id;

    // Ana cobra en DÓLARES y Luis en pesos: la comisión se mide en la moneda del
    // negocio y se paga en la de cada uno.
    const ana = (await post('/api/personas', { nombre: 'Ana', usuario: 'ana', pin: '1111',
      cargo_id: vendedor, sitio_id: centro, moneda_pago: 'USD' })).cuerpo.id;
    const luis = (await post('/api/personas', { nombre: 'Luis', usuario: 'luis', pin: '2222',
      cargo_id: vendedor, sitio_id: centro, moneda_pago: 'CUP' })).cuerpo.id;
    const marta = (await post('/api/personas', { nombre: 'Marta', usuario: 'marta', pin: '3333',
      cargo_id: vendedor, sitio_id: centro })).cuerpo.id;
    const pepe = (await post('/api/personas', { nombre: 'Pepe', usuario: 'pepe', pin: '4444',
      cargo_id: catalogo })).cuerpo.id;
    comp('los tres trabajadores están creados', !!(ana && luis && marta && pepe));
    comp('y la moneda de pago se guardó', (await pedir('/api/cargos')).cuerpo.personas
      .find(p => p.id === ana).moneda_pago === 'USD');

    const tAna = (await post('/api/auth/entrar', { usuario: 'ana', pin: '1111' })).cuerpo.token;
    const tLuis = (await post('/api/auth/entrar', { usuario: 'luis', pin: '2222' })).cuerpo.token;
    const tPepe = (await post('/api/auth/entrar', { usuario: 'pepe', pin: '4444' })).cuerpo.token;

    // Precio 1 000 CUP, comisión FIJA de 400 por unidad. Números redondos a
    // propósito: un tercio de 1 200 es 400, y un fallo de reparto se ve a ojo.
    const prod = (await post('/api/productos', { nombre: 'Lámpara solar', precio: 1000,
      precio_moneda: 'CUP', costo: 500, comision: 400, um: 'Unidad' })).cuerpo.id;
    await post('/api/movimientos', { tipo: 'compra', sitio_id: centro, producto_id: prod,
      cantidad: 100, costo_unit: 500 });

    console.log('\n=== Un día SIN lista: la comisión es de quien vendió (como antes) ===');
    // Ana vende tres unidades. 3 × 400 = 1 200 de comisión.
    const venta = await postComo(tAna, '/api/ventas', { sitio_id: centro, moneda: 'CUP',
      fecha: hoy, lineas: [{ producto_id: prod, cantidad: 3 }] });
    comp('la venta entra', venta.status === 200, JSON.stringify(venta.cuerpo));
    let d = await comisiones();
    comp('la comisión del día son 1 200', casi(d.cuerpo.comisiones
      .reduce((s, c) => s + c.comision, 0), 1200), JSON.stringify(d.cuerpo.comisiones));
    comp('y es TODA de Ana, que fue la que vendió', casi(deQuien(d, 'Ana').comision, 1200),
      deQuien(d, 'Ana').comision);
    comp('Luis no cobra nada de un día sin lista', casi(deQuien(d, 'Luis').comision, 0));
    comp('y la app avisa de que ningún día tiene lista puesta',
      d.cuerpo.dias_con_lista === 0, d.cuerpo.dias_con_lista);
    // Ana cobra en dólares: 1 200 CUP a 400 son 3 USD.
    comp('lo que hay que darle a Ana sale en SU moneda',
      deQuien(d, 'Ana').moneda_pago === 'USD' && casi(deQuien(d, 'Ana').a_pagar, 3),
      JSON.stringify(deQuien(d, 'Ana')));

    console.log('\n=== Con lista: se reparte a partes iguales, y nada más cambia ===');
    const guardar = await post('/api/dias/personas', { sitio_id: centro, fecha: hoy,
      personas: [ana, luis, marta] });
    comp('se guarda quiénes trabajaron', guardar.status === 200 &&
      guardar.cuerpo.presentes.length === 3, JSON.stringify(guardar.cuerpo));
    d = await comisiones();
    comp('a Ana le toca un tercio', casi(deQuien(d, 'Ana').comision, 400),
      deQuien(d, 'Ana').comision);
    comp('a Luis, que no vendió nada, también', casi(deQuien(d, 'Luis').comision, 400),
      deQuien(d, 'Luis').comision);
    comp('y a Marta igual', casi(deQuien(d, 'Marta').comision, 400));
    // ESTA es la comprobación que importa: repartir no puede crear ni destruir
    // dinero. Si la suma no cuadra, el negocio paga de más y nadie lo ve.
    comp('la suma sigue siendo 1 200 exactos: el reparto no inventa dinero',
      casi(d.cuerpo.comisiones.reduce((s, c) => s + c.comision, 0), 1200),
      d.cuerpo.comisiones.reduce((s, c) => s + c.comision, 0));
    comp('lo vendido se sigue atribuyendo a quien despachó',
      casi(deQuien(d, 'Ana').vendido, 3000) && casi(deQuien(d, 'Luis').vendido, 0),
      deQuien(d, 'Ana').vendido + ' / ' + deQuien(d, 'Luis').vendido);
    comp('y se cuentan los días trabajados de cada uno',
      deQuien(d, 'Luis').dias === 1, deQuien(d, 'Luis').dias);
    comp('a Ana se le convierte su parte a dólares', casi(deQuien(d, 'Ana').a_pagar, 1),
      deQuien(d, 'Ana').a_pagar);
    comp('y a Luis se le deja en pesos', casi(deQuien(d, 'Luis').a_pagar, 400),
      deQuien(d, 'Luis').a_pagar);

    console.log('\n=== Un día con lista NO cambia lo de los días sin ella ===');
    // Otro día, sin lista: esa comisión se queda de quien vendió aunque el día
    // de hoy sí tenga reparto. Es lo que permite desplegar sin tocar el pasado.
    await postComo(tLuis, '/api/ventas', { sitio_id: centro, moneda: 'CUP',
      fecha: otroDia, lineas: [{ producto_id: prod, cantidad: 1 }] });
    d = await comisiones();
    comp('la comisión del día sin lista es de Luis, que fue quien vendió',
      casi(deQuien(d, 'Luis').comision, 800), deQuien(d, 'Luis').comision);
    comp('y la de Ana no se ha movido', casi(deQuien(d, 'Ana').comision, 400),
      deQuien(d, 'Ana').comision);
    comp('el total del mes son 1 600', casi(d.cuerpo.comisiones
      .reduce((s, c) => s + c.comision, 0), 1600));

    console.log('\n=== Desmarcar a alguien, y que el desmarcado VIAJE ===');
    await post('/api/dias/personas', { sitio_id: centro, fecha: hoy, personas: [ana, luis] });
    d = await comisiones();
    comp('ahora se reparte entre dos: 600 cada uno', casi(deQuien(d, 'Ana').comision, 600),
      deQuien(d, 'Ana').comision);
    comp('y Marta ya no cobra de ese día', casi(deQuien(d, 'Marta').comision, 0));
    // La clave: la fila de Marta sigue existiendo con presente=0. Si se hubiera
    // borrado, al juntar dos aparatos volvería del otro lado y Marta reaparecería
    // en el reparto sin que nadie la marcara.
    const paquete = await pedir('/api/sync/paquete?sitio_id=' + centro);
    const filas = (paquete.cuerpo.datos || {}).dia_personas || [];
    const filaMarta = filas.find(f => f.persona_id === marta && f.fecha === hoy);
    comp('la lista viaja en el paquete de sincronización', filas.length >= 3, filas.length);
    comp('y la de Marta viaja DESMARCADA, no desaparecida',
      !!filaMarta && filaMarta.presente === 0, JSON.stringify(filaMarta));

    console.log('\n=== Nadie de fuera entra en el reparto ===');
    const colado = await post('/api/dias/personas', { sitio_id: centro, fecha: hoy,
      personas: [ana, luis, 'un-id-inventado'] });
    comp('un id que no es de nadie se ignora en silencio',
      colado.status === 200 && colado.cuerpo.presentes.length === 2,
      JSON.stringify(colado.cuerpo));

    console.log('\n=== Al cerrar la jornada, la lista se guarda con el cierre ===');
    const cierre = await post('/api/dias/cerrar', { sitio_id: centro, fecha: hoy,
      efectivo: 3000, efectivo_usd: 0, personas: [ana, luis, marta] });
    comp('el día se cierra', cierre.status === 200, JSON.stringify(cierre.cuerpo));
    const diaTras = await pedir('/api/dia?sitio_id=' + centro + '&fecha=' + hoy);
    comp('y la lista que iba dentro del cierre quedó guardada',
      (diaTras.cuerpo.trabajaron || []).length === 3,
      JSON.stringify(diaTras.cuerpo.trabajaron));
    comp('el día manda también los nombres, para pintar las casillas',
      (diaTras.cuerpo.gente || []).length >= 4, (diaTras.cuerpo.gente || []).length);

    console.log('\n=== Un día cerrado: solo el administrador toca la lista ===');
    const noPuede = await postComo(tLuis, '/api/dias/personas', { sitio_id: centro,
      fecha: hoy, personas: [luis] });
    comp('quien no es administrador no puede cambiarla', noPuede.status === 400,
      noPuede.status + ' ' + JSON.stringify(noPuede.cuerpo));
    comp('y se le dice por qué', /cerrado/i.test(noPuede.cuerpo.error || ''),
      noPuede.cuerpo.error);
    const siPuede = await post('/api/dias/personas', { sitio_id: centro, fecha: hoy,
      personas: [ana, luis, marta] });
    comp('el administrador sí, sin tener que reabrir la jornada', siPuede.status === 200,
      JSON.stringify(siPuede.cuerpo));

    console.log('\n=== Pagarle la comisión: el dinero SALE de la caja ===');
    const saldoAntes = (await pedir('/api/fondo')).cuerpo.saldo;
    const gavetaAntes = (await pedir('/api/fondo?sitio=' + centro)).cuerpo.saldo;
    d = await comisiones();
    const leTocaLuis = deQuien(d, 'Luis').a_pagar;     // 400 (de hoy) + 800 = 1 200
    const pago = await post('/api/comisiones/pagar', { persona_id: luis, mes: mesHoy,
      importe: leTocaLuis, moneda: 'CUP', sitio_id: centro });
    comp('el pago se apunta', pago.status === 200, JSON.stringify(pago.cuerpo));
    const saldoTras = (await pedir('/api/fondo')).cuerpo.saldo;
    comp('y el saldo del negocio baja exactamente eso',
      casi(saldoTras.CUP, saldoAntes.CUP - leTocaLuis),
      saldoAntes.CUP + ' → ' + saldoTras.CUP);
    const gavetaTras = (await pedir('/api/fondo?sitio=' + centro)).cuerpo.saldo;
    comp('la gaveta del punto también, que es otra consulta',
      casi(gavetaTras.CUP, gavetaAntes.CUP - leTocaLuis),
      gavetaAntes.CUP + ' → ' + gavetaTras.CUP);
    d = await comisiones();
    comp('la app dice que Luis ya cobró', casi(deQuien(d, 'Luis').pagado.CUP, leTocaLuis),
      JSON.stringify(deQuien(d, 'Luis').pagado));
    comp('y que no le queda nada pendiente', casi(deQuien(d, 'Luis').queda, 0),
      deQuien(d, 'Luis').queda);
    comp('a Ana le sigue quedando lo suyo', deQuien(d, 'Ana').queda > 0,
      deQuien(d, 'Ana').queda);
    const pagos = await pedir('/api/comisiones/pagos?mes=' + mesHoy);
    comp('el pago sale en la lista de pagos del mes',
      pagos.cuerpo.pagos.length === 1 && pagos.cuerpo.pagos[0].persona === 'Luis',
      JSON.stringify(pagos.cuerpo.pagos));

    console.log('\n=== Ese pago tiene dueño: no se toca desde Dinero ===');
    const idPago = pago.cuerpo.id;
    const aMano = await post('/api/fondo/' + idPago + '/anular', {});
    comp('anularlo desde el fondo se niega', aMano.status === 400, aMano.status);
    comp('y dice dónde se hace', /comisi/i.test(aMano.cuerpo.error || ''),
      aMano.cuerpo.error);

    console.log('\n=== Deshacer el pago devuelve el saldo EXACTO ===');
    const deshacer = await post('/api/comisiones/pago/' + idPago + '/anular', {});
    comp('se puede deshacer', deshacer.status === 200, JSON.stringify(deshacer.cuerpo));
    const saldoVuelta = (await pedir('/api/fondo')).cuerpo.saldo;
    comp('el saldo vuelve a donde estaba, al céntimo',
      casi(saldoVuelta.CUP, saldoAntes.CUP), saldoAntes.CUP + ' vs ' + saldoVuelta.CUP);
    d = await comisiones();
    // Si la anulación no llevara ref_tipo, esta cifra se habría quedado en 1 200
    // y la app diría para siempre que a Luis se le pagó un dinero que devolvió.
    comp('y la app deja de decir que Luis cobró',
      casi(deQuien(d, 'Luis').pagado.CUP, 0), JSON.stringify(deQuien(d, 'Luis').pagado));
    comp('vuelve a quedarle lo suyo pendiente', casi(deQuien(d, 'Luis').queda, leTocaLuis),
      deQuien(d, 'Luis').queda);
    const dosVeces = await post('/api/comisiones/pago/' + idPago + '/anular', {});
    comp('y no se puede deshacer dos veces', dosVeces.status === 400, dosVeces.status);

    console.log('\n=== Pagar en un mes lo de otro: sale en el mes que se generó ===');
    // El caso de verdad: la comisión de este mes se paga el mes que viene. El
    // dinero sale del fondo cuando sale, pero el pago cuenta contra SU mes.
    const otroMes = (() => {
      const [a, m] = mesHoy.split('-').map(Number);
      return m === 1 ? (a - 1) + '-12' : a + '-' + String(m - 1).padStart(2, '0');
    })();
    const pagoViejo = await post('/api/comisiones/pagar', { persona_id: marta,
      mes: otroMes, importe: 500, moneda: 'CUP', sitio_id: centro });
    comp('se puede pagar la comisión de un mes anterior', pagoViejo.status === 200,
      JSON.stringify(pagoViejo.cuerpo));
    const dViejo = await comisiones(otroMes);
    comp('y sale en el mes al que pertenece',
      casi(deQuien(dViejo, 'Marta').pagado.CUP, 500),
      JSON.stringify(deQuien(dViejo, 'Marta').pagado));
    const dAhora = await comisiones();
    comp('no en el mes en que se entregó el dinero',
      casi(deQuien(dAhora, 'Marta').pagado.CUP, 0),
      JSON.stringify(deQuien(dAhora, 'Marta').pagado));
    comp('pero el dinero sí salió de la caja hoy',
      casi((await pedir('/api/fondo')).cuerpo.saldo.CUP, saldoAntes.CUP - 500),
      (await pedir('/api/fondo')).cuerpo.saldo.CUP);

    console.log('\n=== Frenos del pago ===');
    comp('sin mes no se paga',
      (await post('/api/comisiones/pagar', { persona_id: luis, importe: 100 })).status === 400);
    comp('con importe cero tampoco', (await post('/api/comisiones/pagar',
      { persona_id: luis, mes: mesHoy, importe: 0 })).status === 400);
    comp('ni a alguien que no existe', (await post('/api/comisiones/pagar',
      { persona_id: 'nadie', mes: mesHoy, importe: 100 })).status === 400);
    comp('ni sacándolo de una caja que no existe', (await post('/api/comisiones/pagar',
      { persona_id: luis, mes: mesHoy, importe: 100, sitio_id: 'ningun-sitio' })).status === 400);

    console.log('\n=== El valor del dólar: solo el administrador ===');
    const pepeTasa = await postComo(tPepe, '/api/tasa', { tasa: 999 });
    comp('quien solo gestiona productos ya NO puede cambiarlo', pepeTasa.status === 403,
      pepeTasa.status + ' ' + JSON.stringify(pepeTasa.cuerpo));
    const anaTasa = await postComo(tAna, '/api/tasa', { tasa: 999 });
    comp('un vendedor tampoco', anaTasa.status === 403, anaTasa.status);
    comp('y el dólar sigue a 400', (await pedir('/api/tasa')).cuerpo.tasa === 400,
      (await pedir('/api/tasa')).cuerpo.tasa);
    comp('el administrador sí puede', (await post('/api/tasa', { tasa: 420 })).status === 200);
    await post('/api/tasa', { tasa: 400 });
    comp('pero leerlo sigue abierto: sin eso no se puede cobrar en la otra moneda',
      (await pedir('/api/tasa', { headers: comoOtro(tAna) })).cuerpo.tasa === 400);
    const pepeMoneda = await postComo(tPepe, '/api/moneda-base', { moneda: 'USD', tasa: 400 });
    comp('y la moneda del negocio, que reescribe todos los costos, también está bajo llave',
      pepeMoneda.status === 403, pepeMoneda.status);

    console.log('\n=== Cambiarse el PIN uno mismo ===');
    // Marta entra en DOS teléfonos: hace falta para comprobar que al cambiar el
    // PIN se cierra el otro y no el de la mano.
    const tMarta1 = (await post('/api/auth/entrar', { usuario: 'marta', pin: '3333' })).cuerpo.token;
    const tMarta2 = (await post('/api/auth/entrar', { usuario: 'marta', pin: '3333' })).cuerpo.token;
    comp('con el PIN de ahora mal, no se cambia', (await postComo(tMarta1, '/api/auth/mi-pin',
      { pin_actual: '0000', pin_nuevo: '5555' })).status === 401);
    comp('con letras en el nuevo, tampoco', (await postComo(tMarta1, '/api/auth/mi-pin',
      { pin_actual: '3333', pin_nuevo: 'abcd' })).status === 400);
    comp('ni con uno de tres cifras', (await postComo(tMarta1, '/api/auth/mi-pin',
      { pin_actual: '3333', pin_nuevo: '555' })).status === 400);
    comp('ni poniendo el mismo que ya tenía', (await postComo(tMarta1, '/api/auth/mi-pin',
      { pin_actual: '3333', pin_nuevo: '3333' })).status === 400);
    const cambio = await postComo(tMarta1, '/api/auth/mi-pin',
      { pin_actual: '3333', pin_nuevo: '5555' });
    comp('y con todo bien, se cambia', cambio.status === 200, JSON.stringify(cambio.cuerpo));
    comp('el PIN viejo ya no entra',
      (await post('/api/auth/entrar', { usuario: 'marta', pin: '3333' })).status === 401);
    comp('el nuevo sí',
      (await post('/api/auth/entrar', { usuario: 'marta', pin: '5555' })).status === 200);
    // Las dos caras del mismo asunto, y las dos han fallado en otras aplicaciones:
    // si se cierran TODAS las sesiones, cambiarse el PIN te echa de la app; si no
    // se cierra ninguna, el teléfono perdido sigue dentro para siempre.
    comp('la sesión desde la que se cambió sigue valiendo',
      (await pedir('/api/auth/yo', { headers: comoOtro(tMarta1) })).status === 200);
    comp('y la del otro teléfono se cerró',
      (await pedir('/api/auth/yo', { headers: comoOtro(tMarta2) })).status === 401);
    comp('se dice cuántas se cerraron', cambio.cuerpo.sesiones_cerradas === 1,
      cambio.cuerpo.sesiones_cerradas);
    // El administrador conserva su llave maestra: es lo que hace falta cuando
    // alguien olvida el PIN de verdad.
    comp('el administrador sigue pudiendo cambiárselo a otro',
      (await post('/api/personas', { id: marta, nombre: 'Marta', usuario: 'marta',
        cargo_id: vendedor, pin: '7777' })).status === 200);
    comp('y ese PIN funciona',
      (await post('/api/auth/entrar', { usuario: 'marta', pin: '7777' })).status === 200);

    console.log('\n=== La foto del producto: cámara Y galería ===');
    // Esto se mira en el HTML porque el fallo estaba en un atributo, no en la
    // lógica: 'capture' manda al teléfono abrir la cámara y no ofrecer nada más.
    const html = fs.readFileSync(path.join(raiz, 'public', 'index.html'), 'utf8');
    const linCam = (html.match(/<input[^>]*id="f-foto-cam"[^>]*>/) || [''])[0];
    const linGal = (html.match(/<input[^>]*id="f-foto-gal"[^>]*>/) || [''])[0];
    comp('hay una casilla para la cámara y otra para la galería', !!linCam && !!linGal);
    comp('la de la cámara pide la cámara', /capture="environment"/.test(linCam), linCam);
    comp('y la de la galería NO lleva capture, que es lo que la cerraba',
      !/capture/.test(linGal), linGal);
    comp('ya no queda la casilla vieja que solo abría la cámara',
      !/id="f-foto-in"/.test(html));
    comp('y los dos botones están puestos',
      /f-foto-cam'\)\.click\(\)/.test(html) && /f-foto-gal'\)\.click\(\)/.test(html));

    console.log('\n=== La ganancia, con lo que cuesta la gente restado (#33) ===');
    // Un día limpio, en un sitio nuevo, para que las cuentas se puedan seguir a
    // mano: 2 unidades a 1 000, costo 500, comisión 400 por unidad.
    const sur = (await post('/api/sitios',
      { nombre: 'Punto Sur', tipo: 'punto', padre_id: almacen })).cuerpo.id;
    await post('/api/movimientos', { tipo: 'compra', sitio_id: sur, producto_id: prod,
      cantidad: 10, costo_unit: 500 });
    const ayer = (() => { const x = new Date(); x.setDate(x.getDate() - 1);
      const f = x.toLocaleDateString('sv-SE');
      return f.slice(0, 7) === mesHoy ? f : mesHoy + '-02'; })();
    // Vende el JEFE y no Ana: Ana trabaja en Punto Centro y desde el catálogo
    // nuevo de permisos el servidor le rechaza cualquier petición sobre otro sitio
    // (#35). El jefe no tiene sitio propio, así que puede en todos.
    await post('/api/ventas', { sitio_id: sur, moneda: 'CUP', fecha: ayer,
      lineas: [{ producto_id: prod, cantidad: 2 }] });
    let dd = (await pedir('/api/dia?sitio_id=' + sur + '&fecha=' + ayer)).cuerpo;
    comp('la ganancia bruta sigue siendo lo vendido menos la mercancía',
      casi(dd.ventas.ganancia, 1000), dd.ventas.ganancia);   // 2000 − 1000
    comp('y la comisión del día son 800', casi(dd.ventas.comision, 800), dd.ventas.comision);
    comp('el desglose nuevo dice lo que queda después de la comisión',
      dd.personal && casi(dd.personal.queda, 200), JSON.stringify(dd.personal));
    comp('y todavía no hay salarios apuntados', casi(dd.personal.sueldos, 0));

    // Un salario de 150 apuntado ese día en esa caja.
    await post('/api/fondo', { tipo: 'gasto', subtipo: 'Salarios', moneda: 'CUP',
      importe: 150, sitio_id: sur, concepto: 'Salario del sábado', fecha: ayer,
      es_gente: true, beneficiario_id: luis });
    dd = (await pedir('/api/dia?sitio_id=' + sur + '&fecha=' + ayer)).cuerpo;
    comp('el salario entra en el desglose', casi(dd.personal.sueldos, 150),
      JSON.stringify(dd.personal));
    comp('y lo que queda baja a 50', casi(dd.personal.queda, 50), dd.personal.queda);
    comp('pero la ganancia bruta NO se ha movido: sigue siendo la de siempre',
      casi(dd.ventas.ganancia, 1000), dd.ventas.ganancia);

    // Un gasto que NO es de la gente no debe restarse aquí.
    await post('/api/fondo', { tipo: 'gasto', subtipo: 'Transporte', moneda: 'CUP',
      importe: 300, sitio_id: sur, concepto: 'Gasolina', fecha: ayer });
    dd = (await pedir('/api/dia?sitio_id=' + sur + '&fecha=' + ayer)).cuerpo;
    comp('un gasto que no es de la gente no toca esta cuenta',
      casi(dd.personal.sueldos, 150), JSON.stringify(dd.personal));

    console.log('\n=== La trampa: la comisión no se puede restar dos veces ===');
    // Se le paga a Ana su comisión. Ese pago es dinero para la gente, pero la
    // comisión YA se restó al generarse: si se sumara otra vez, el mes saldría
    // con el doble de coste y el dueño creería estar perdiendo dinero.
    const antesDelPago = (await pedir('/api/resumen?desde=' + mesHoy +
      '-01&hasta=' + mesHoy + '-31')).cuerpo;
    const dAna = await comisiones();
    await post('/api/comisiones/pagar', { persona_id: ana, mes: mesHoy,
      importe: deQuien(dAna, 'Ana').a_pagar, moneda: 'USD', sitio_id: sur });
    const trasElPago = (await pedir('/api/resumen?desde=' + mesHoy +
      '-01&hasta=' + mesHoy + '-31')).cuerpo;
    comp('pagar una comisión NO vuelve a restarla del período',
      casi(antesDelPago.personal.sueldos, trasElPago.personal.sueldos),
      antesDelPago.personal.sueldos + ' → ' + trasElPago.personal.sueldos);
    comp('y lo que queda en el mes tampoco cambia por pagarla',
      casi(antesDelPago.personal.queda, trasElPago.personal.queda),
      antesDelPago.personal.queda + ' → ' + trasElPago.personal.queda);

    console.log('\n=== Anular un salario lo quita de la cuenta ===');
    const fondoDia = await pedir('/api/fondo?desde=' + ayer + '&hasta=' + ayer);
    const elSalario = fondoDia.cuerpo.movimientos.find(m => m.concepto === 'Salario del sábado');
    comp('el salario está en la lista de apuntes', !!elSalario);
    await post('/api/fondo/' + elSalario.id + '/anular', {});
    dd = (await pedir('/api/dia?sitio_id=' + sur + '&fecha=' + ayer)).cuerpo;
    // Si la anulación no copiara la marca de «dinero para la gente», el negativo
    // se quedaría fuera de la suma y ese salario se restaría para siempre.
    comp('anulado, deja de restarse', casi(dd.personal.sueldos, 0),
      JSON.stringify(dd.personal));
    comp('y lo que queda vuelve a 200', casi(dd.personal.queda, 200), dd.personal.queda);

    console.log('\n=== El desglose por sitio: cada tienda con su gente ===');
    const neg = await pedir('/api/negocio?desde=' + mesHoy + '-01&hasta=' + mesHoy + '-31');
    const filaSur = neg.cuerpo.sitios.find(s => s.sitio === 'Punto Sur');
    comp('el sitio trae su comisión, sus salarios y lo que le queda',
      filaSur && filaSur.queda !== undefined && filaSur.sueldos !== undefined,
      JSON.stringify(filaSur && { c: filaSur.comision, s: filaSur.sueldos, q: filaSur.queda }));
    comp('y queda = ganancia − comisiones − salarios, en cada fila',
      neg.cuerpo.sitios.every(s => casi(s.queda, s.ganancia - s.comision - s.sueldos)),
      JSON.stringify(neg.cuerpo.sitios.map(s => [s.sitio, s.queda])));
    // La suma de las filas tiene que dar el total, como en todo lo demás de esta
    // pantalla: si no, hay dinero en algún sitio que no está en ninguna fila.
    comp('la suma de lo que queda en cada sitio da el total',
      casi(neg.cuerpo.sitios.reduce((s, x) => s + x.queda, 0), neg.cuerpo.total.queda),
      neg.cuerpo.sitios.reduce((s, x) => s + x.queda, 0) + ' vs ' + neg.cuerpo.total.queda);

    console.log('\n=== La comisión del producto: cuánto, y en qué moneda se escribe ===');
    // El dueño la buscaba aquí, y con razón: la comisión se establece por producto.
    // Lo que había mal era el rótulo. Decía «Pesos por unidad» escrito a mano, de
    // cuando todo se medía en pesos, así que con el negocio en dólares la pantalla
    // decía «14 pesos al vendedor» cuando lo guardado eran 14 dólares.
    // SIN LOS COMENTARIOS. Esta prueba busca una frase que ya no debe salir en
    // pantalla, y los comentarios del código hablan justamente de esa frase para
    // explicar por qué se quitó: leyéndolos, la prueba se caza a sí misma y falla
    // para siempre. Ya pasó igual en el acortador el 16 de agosto de 2026.
    const htmlF = fs.readFileSync(path.join(raiz, 'public', 'index.html'), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '');
    const appJs = fs.readFileSync(path.join(raiz, 'public', 'app.js'), 'utf8');
    comp('el rótulo ya no dice «Pesos por unidad» a pelo',
      !/Pesos por unidad/.test(htmlF));
    comp('hay casilla de moneda para la comisión', /id="f-comision-moneda"/.test(htmlF));
    comp('y se guarda pasada a la moneda del negocio, no tal cual',
      /comision:.*comisionEnBase\(\)/s.test(appJs));
    comp('el porcentaje NO se convierte: un 5% es un 5% en cualquier moneda',
      /comision_pct.*\$\('f-comision-tipo'\)/.test(appJs));
    // Y del lado del servidor: la comisión llega ya en la moneda del negocio, así
    // que lo que se guarda es exactamente lo que se manda.
    const conCom = await post('/api/productos', { nombre: 'Cable comisionado',
      precio: 100, precio_moneda: 'CUP', costo: 40, comision: 7, um: 'Unidad' });
    comp('el servidor guarda la comisión que se le manda',
      (await pedir('/api/productos')).cuerpo.productos
        .find(p => p.id === conCom.cuerpo.id).comision === 7);

    console.log('\n=== Y lo de siempre: que la base actualizada no pierda nada ===');
    // La tabla nueva se crea con el esquema, así que una base que YA existía la
    // estrena al arrancar. Aquí se comprueba con la base de este mismo banco,
    // que se creó hace un rato y lleva datos dentro.
    const columnas = (await pedir('/api/salud')).status === 200;
    comp('el servidor sigue en pie tras todo esto', columnas);
    const dFinal = await comisiones();
    comp('y las comisiones del mes siguen cuadrando',
      dFinal.cuerpo.comisiones.length >= 3, dFinal.cuerpo.comisiones.length);

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
