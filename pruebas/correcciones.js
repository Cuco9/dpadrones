// Corregir y quitar apuntes del fondo, y dar de baja un cargo.
//
// Pedido por el dueño el 16 de agosto de 2026: «necesito poder editar y borrar
// los retiros, ingresos y gastos» y «necesito poder eliminar cargos que haya
// creado». Va contra la decisión #2 —los apuntes no se tocan— y por eso no se
// tocan de verdad: se anula con el apunte contrario y el cargo se marca de
// baja. Está explicado en la decisión #31.
//
// Lo que se comprueba aquí es lo que puede salir mal sin que se note:
//
//   · que el saldo vuelva EXACTAMENTE a donde estaba, en las dos monedas;
//   · que el resumen del período no se quede con un ingreso que se anuló;
//   · que la gaveta del sitio, que es otra consulta, cuadre igual;
//   · que el dinero que viene de una venta NO se pueda quitar desde el fondo,
//     porque ese apunte tiene otro dueño (#3);
//   · y que un cargo que alguien tiene puesto no se vaya, o esa persona se
//     quedaría sin permisos sin saber por qué.
//
//   node pruebas/correcciones.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const raiz = path.join(__dirname, '..');
const patio = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-corr-'));

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
const quitar = ruta => pedir(ruta, { method: 'DELETE' });
const hoy = new Date().toLocaleDateString('sv-SE');
const fondo = () => pedir('/api/fondo?desde=' + hoy + '&hasta=' + hoy);

(async () => {
  try {
    const PUERTO = await puertoLibre();
    BASE = 'http://127.0.0.1:' + PUERTO;
    await arrancar({ PUERTO, DP_DB: path.join(patio, 'app.db'), DP_HTTP: '1' },
                   /D´Padrones/);

    console.log('\n=== Preparar: administrador, dos sitios y el dólar puesto ===');
    await post('/api/auth/crear-admin', { nombre: 'Jefe', usuario: 'jefe', pin: '1234' });
    const ses = await post('/api/auth/entrar', { usuario: 'jefe', pin: '1234' });
    cab = { Authorization: 'Bearer ' + ses.cuerpo.token };
    await post('/api/tasa', { tasa: 400 });
    // El «Almacén Principal» que siembra la aplicación es el MIRADOR: desde ahí se
    // ven los totales de todos sumados y no se guarda nada (DECISIONES.md #48).
    // El almacén de verdad, el que tiene la mercancía, se crea aquí.
    const almacen = (await post('/api/sitios',
      { nombre: 'Almacén Central', tipo: 'almacen' })).cuerpo.id;
    const centro = (await post('/api/sitios',
      { nombre: 'Punto Centro', tipo: 'punto', padre_id: almacen })).cuerpo.id;
    comp('los dos sitios están', !!(almacen && centro));

    console.log('\n=== Un gasto apuntado a mano, y quitarlo ===');
    await post('/api/fondo', { tipo: 'ingreso', subtipo: 'aporte', moneda: 'CUP',
      importe: 100000, sitio_id: centro, concepto: 'Capital inicial', fecha: hoy });
    const antes = (await fondo()).cuerpo;
    const saldoAntes = antes.saldo.CUP;

    await post('/api/fondo', { tipo: 'gasto', subtipo: 'transporte', moneda: 'CUP',
      importe: 7000, sitio_id: centro, concepto: 'Gasolina, mal apuntada', fecha: hoy });
    const conGasto = (await fondo()).cuerpo;
    comp('el gasto baja el saldo', casi(conGasto.saldo.CUP, saldoAntes - 7000),
      conGasto.saldo.CUP);
    const gasto = conGasto.movimientos.find(m => m.concepto === 'Gasolina, mal apuntada');
    comp('y sale en la lista', !!gasto);

    // Quién lo apuntó. Antes esta casilla se quedaba siempre vacía, y la ficha
    // del apunte decía «Registrado por —» pasara lo que pasara.
    const ficha = await pedir('/api/fondo/' + gasto.id);
    comp('el apunte dice quién lo hizo', ficha.cuerpo.apunte.persona === 'Jefe',
      ficha.cuerpo.apunte.persona);
    comp('y el servidor dice que se puede tocar', ficha.cuerpo.se_puede_tocar === true);
    comp('y que todavía no está anulado', ficha.cuerpo.anulado === false);

    const anul = await post('/api/fondo/' + gasto.id + '/anular');
    comp('se puede anular', anul.status === 200, JSON.stringify(anul.cuerpo));
    const tras = (await fondo()).cuerpo;
    comp('el saldo vuelve EXACTAMENTE a donde estaba',
      casi(tras.saldo.CUP, saldoAntes), tras.saldo.CUP);
    comp('el gasto del período vuelve a cero', casi(tras.resumen.CUP.gasto, 0),
      tras.resumen.CUP.gasto);
    comp('ni el apunte ni su anulación ensucian la lista',
      !tras.movimientos.some(m => m.id === gasto.id) &&
      !tras.movimientos.some(m => m.anula_a === gasto.id),
      JSON.stringify(tras.movimientos.map(m => m.concepto)));

    const conAnulados = (await pedir('/api/fondo?desde=' + hoy + '&hasta=' + hoy +
      '&anulados=1')).cuerpo;
    const viejo = conAnulados.movimientos.find(m => m.id === gasto.id);
    comp('pero se ven pidiéndolos, que el histórico está entero', !!viejo);
    comp('y el viejo viene marcado como anulado', !!(viejo && viejo.anulado));
    const contrario = conAnulados.movimientos.find(m => m.anula_a === gasto.id);
    comp('la anulación es del MISMO tipo, con el importe en negativo',
      !!contrario && contrario.tipo === 'gasto' && casi(contrario.importe, -7000),
      contrario && contrario.tipo + ' ' + contrario.importe);
    comp('y se apunta con la fecha del original, no con la de hoy',
      !!contrario && contrario.fecha === gasto.fecha);

    console.log('\n=== La gaveta del sitio, que se calcula por otro camino ===');
    const g = (tras.gavetas || []).find(x => x.sitio_id === centro);
    comp('la caja del punto cuadra tras anular', !!g && casi(g.CUP, 100000),
      g && g.CUP);
    const neg = (await pedir('/api/negocio?desde=' + hoy + '&hasta=' + hoy)).cuerpo;
    const fila = (neg.sitios || []).find(p => p.sitio_id === centro);
    comp('y el mirador del almacén dice lo mismo',
      !!fila && casi(fila.gaveta.CUP, 100000), fila && fila.gaveta.CUP);
    comp('el gasto tampoco le queda al sitio en el período',
      !!fila && casi(fila.fondo.CUP.gasto, 0), fila && fila.fondo.CUP.gasto);

    console.log('\n=== Anular dos veces, no ===');
    const otra = await post('/api/fondo/' + gasto.id + '/anular');
    comp('el mismo apunte no se anula dos veces', otra.status === 400, otra.status);
    const laAnulacion = await post('/api/fondo/' + contrario.id + '/anular');
    comp('y una anulación tampoco se anula', laAnulacion.status === 400, laAnulacion.status);
    const fantasma = await post('/api/fondo/no-existe/anular');
    comp('un apunte que no existe contesta 404', fantasma.status === 404, fantasma.status);
    comp('y el saldo no se movió con ninguno de los tres intentos',
      casi((await fondo()).cuerpo.saldo.CUP, saldoAntes));

    console.log('\n=== Corregir: se apunta bien y el viejo queda anulado ===');
    await post('/api/fondo', { tipo: 'retiro', subtipo: 'salario', moneda: 'CUP',
      importe: 50000, sitio_id: centro, concepto: 'Salario de agosto', fecha: hoy });
    const conRetiro = (await fondo()).cuerpo;
    const retiro = conRetiro.movimientos.find(m => m.concepto === 'Salario de agosto');
    const corr = await post('/api/fondo/' + retiro.id + '/corregir', {
      tipo: 'retiro', subtipo: 'salario', moneda: 'CUP', importe: 45000,
      sitio_id: centro, concepto: 'Salario de agosto (corregido)', fecha: hoy });
    comp('se puede corregir', corr.status === 200, JSON.stringify(corr.cuerpo));
    const trasCorr = (await fondo()).cuerpo;
    comp('el saldo es el de la cifra buena, no el de las dos',
      casi(trasCorr.saldo.CUP, saldoAntes - 45000), trasCorr.saldo.CUP);
    comp('el retiro del período es 45 000 y no 95 000',
      casi(trasCorr.resumen.CUP.retiro, 45000), trasCorr.resumen.CUP.retiro);
    comp('en la lista queda UN apunte, el corregido',
      trasCorr.movimientos.filter(m => /Salario de agosto/.test(m.concepto)).length === 1,
      JSON.stringify(trasCorr.movimientos.map(m => m.concepto)));
    comp('y el viejo ya no se puede volver a tocar',
      (await post('/api/fondo/' + retiro.id + '/corregir', { importe: 1 })).status === 400);

    console.log('\n=== Lo que corregir NO puede colar ===');
    // Con sitio: desde el 17 de agosto de 2026 el dinero que sale tiene que decir de
    // qué caja (DECISIONES.md #37).
    await post('/api/fondo', { tipo: 'gasto', subtipo: 'otros', moneda: 'CUP',
      importe: 1000, sitio_id: centro, concepto: 'Para probar los frenos', fecha: hoy });
    const pruebaId = (await fondo()).cuerpo.movimientos
      .find(m => m.concepto === 'Para probar los frenos').id;
    comp('un importe en cero no pasa',
      (await post('/api/fondo/' + pruebaId + '/corregir', { importe: 0 })).status === 400);
    comp('un importe en negativo tampoco',
      (await post('/api/fondo/' + pruebaId + '/corregir', { importe: -5 })).status === 400);
    comp('un tipo inventado tampoco',
      (await post('/api/fondo/' + pruebaId + '/corregir',
        { tipo: 'regalo', importe: 10 })).status === 400);
    comp('y una inversión sin declarar de qué tipo es, tampoco',
      (await post('/api/fondo/' + pruebaId + '/corregir',
        { tipo: 'inversion', subtipo: '', importe: 10 })).status === 400);
    comp('después de los cuatro intentos el apunte sigue como estaba',
      casi((await fondo()).cuerpo.movimientos
        .find(m => m.id === pruebaId).importe, 1000));

    console.log('\n=== No se saca de una caja lo que no tiene dentro ===');
    // Pedido por el dueño el 21 de agosto de 2026 (DECISIONES.md #38): «no me puede
    // retirar dinero del fondo si no existe el dinero, tiene que mostrarme un cartel
    // de que no tengo ese dinero y prohibírmelo». Una gaveta en negativo no existe:
    // si sale, es que falta apuntar un dinero que entró o que alguien se equivocó
    // de caja, y a partir de ahí ninguna cifra del fondo se puede creer.
    const enCaja = async () => (((await fondo()).cuerpo.gavetas || [])
      .find(x => x.sitio_id === centro) || { CUP: 0, USD: 0 });
    const hayCUP = (await enCaja()).CUP;
    comp('la caja del punto tiene dinero para probar', hayCUP > 0, hayCUP);

    const dePlus = await post('/api/fondo', { tipo: 'retiro', subtipo: 'Préstamo',
      moneda: 'CUP', importe: hayCUP + 1, sitio_id: centro,
      concepto: 'Un peso más de lo que hay', fecha: hoy });
    comp('un retiro de un peso más de lo que hay se rechaza', dePlus.status === 400,
      JSON.stringify(dePlus.cuerpo));
    comp('y el cartel dice cuánto hay y cuánto se está sacando',
      /hay .* y estás sacando /.test(dePlus.cuerpo.error || ''), dePlus.cuerpo.error);
    comp('y dice qué hacer, no solo que no', /apúntalo primero como/.test(dePlus.cuerpo.error || ''),
      dePlus.cuerpo.error);
    comp('la caja no se movió ni un peso', casi((await enCaja()).CUP, hayCUP));

    // La moneda cuenta: son dos gavetas distintas. Tener pesos no da para sacar
    // dólares, y sumarlos al valor del dólar sería inventar un cambio que nadie hizo.
    const enOtraMoneda = await post('/api/fondo', { tipo: 'gasto', subtipo: 'Transporte',
      moneda: 'USD', importe: 1, sitio_id: centro, concepto: 'Un dólar que no hay', fecha: hoy });
    comp('con pesos en la caja no se saca un dólar', enOtraMoneda.status === 400,
      JSON.stringify(enOtraMoneda.cuerpo));

    // Sacar EXACTAMENTE lo que hay sí se puede: dejar la caja en cero es normal,
    // dejarla en negativo es imposible. Y se deshace para no cambiarle el estado
    // a las pruebas que vienen detrás.
    const justo = await post('/api/fondo', { tipo: 'retiro', subtipo: 'Préstamo',
      moneda: 'CUP', importe: hayCUP, sitio_id: centro, concepto: 'Justo lo que hay',
      fecha: hoy });
    comp('sacar exactamente lo que hay sí pasa', justo.status === 200,
      JSON.stringify(justo.cuerpo));
    comp('y la caja queda en cero, que es legal', casi((await enCaja()).CUP, 0),
      (await enCaja()).CUP);
    const idJusto = (await fondo()).cuerpo.movimientos
      .find(m => m.concepto === 'Justo lo que hay').id;
    await post('/api/fondo/' + idJusto + '/anular');
    comp('al anularlo la caja vuelve a lo que tenía', casi((await enCaja()).CUP, hayCUP));

    // Corregir un apunte para que saque más de lo que hay tampoco pasa, Y la
    // anulación del viejo se va con la transacción: si se quedara escrita, el
    // apunte malo habría desaparecido sin que entrara el bueno. O sea, corregir
    // habría borrado.
    const pasarse = await post('/api/fondo/' + pruebaId + '/corregir',
      { importe: hayCUP + 50000, concepto: 'Corregido a lo grande' });
    comp('corregirlo a más de lo que hay se rechaza', pasarse.status === 400,
      JSON.stringify(pasarse.cuerpo));
    const trasFallo = (await fondo()).cuerpo;
    comp('y el apunte de antes sigue en pie, sin anular',
      casi((trasFallo.movimientos.find(m => m.id === pruebaId) || {}).importe, 1000) &&
      !trasFallo.movimientos.some(m => m.anula_a === pruebaId),
      JSON.stringify(trasFallo.movimientos.map(m => [m.concepto, m.importe])));
    comp('y la caja tampoco se movió', casi((await enCaja()).CUP, hayCUP));

    console.log('\n=== El dinero de una venta no se quita desde el fondo ===');
    // Ese apunte tiene otro dueño: si se borrara aquí, el fondo diría una cosa
    // y la venta otra, y ya no habría forma de saber cuál de las dos miente.
    const prod = await post('/api/productos', { nombre: 'Panel 450W', precio: 500,
      precio_moneda: 'USD', costo: 300, um: 'Unidad' });
    await post('/api/movimientos', { tipo: 'compra', sitio_id: centro,
      producto_id: prod.cuerpo.id, cantidad: 5, costo_unit: 300 });
    await post('/api/ventas', { sitio_id: centro, moneda: 'USD',
      lineas: [{ producto_id: prod.cuerpo.id, cantidad: 1 }] });
    const deVenta = (await fondo()).cuerpo.movimientos.find(m => m.ref_tipo === 'venta');
    comp('la venta dejó su apunte en el fondo', !!deVenta);
    const negado = await post('/api/fondo/' + deVenta.id + '/anular');
    comp('y ese apunte no se puede anular desde aquí', negado.status === 400, negado.status);
    comp('y se dice dónde se deshace, que si no uno se queda mirando',
      /venta/i.test(negado.cuerpo.error || ''), negado.cuerpo.error);
    comp('la ficha de ese apunte tampoco ofrece los botones',
      (await pedir('/api/fondo/' + deVenta.id)).cuerpo.se_puede_tocar === false);

    // El traspaso entre gavetas tiene dos mitades: quitar una sola dejaría el
    // dinero duplicado o perdido según cuál se quitara.
    await post('/api/fondo/traspaso', { origen_id: centro, destino_id: almacen,
      moneda: 'CUP', importe: 1000, concepto: 'Prueba' });
    const mitad = (await fondo()).cuerpo.movimientos.find(m => m.ref_tipo === 'traspaso');
    comp('una mitad de un traspaso tampoco se anula suelta',
      (await post('/api/fondo/' + mitad.id + '/anular')).status === 400);

    console.log('\n=== La ficha de CUALQUIER apunte tiene que abrir ===');
    // No se prueba «un apunte»: se piden TODOS los que haya, con sus orígenes
    // distintos, que es lo que hace quien está delante. Una consulta rota en
    // una sola de esas ramas deja la ventana en blanco y no lo caza nada más.
    const todosLos = (await fondo()).cuerpo.movimientos;
    const origenesVistos = new Set(todosLos.map(m => m.ref_tipo || 'a mano'));
    comp('en la lista hay apuntes de varios orígenes',
      ['a mano', 'venta', 'traspaso'].every(o => origenesVistos.has(o)),
      [...origenesVistos].join(', '));
    let abrieron = 0;
    for (const m of todosLos) {
      const ficha = (await pedir('/api/fondo/' + m.id)).cuerpo;
      if (ficha && ficha.apunte) abrieron++;
    }
    comp('y todas las fichas abren, sin una sola consulta rota',
      abrieron === todosLos.length, abrieron + ' de ' + todosLos.length);
    // Esta comprobación existe por un fallo que llevaba ahí desde que se
    // escribió la pantalla y que solo salió mirando los registros del VPS: la
    // ficha de un apunte que venía de un trabajo pedía «c.total» a la tabla de
    // cotizaciones, y ese total NO es una columna —se suma de las líneas más la
    // mano de obra (#1)—. SQLite tumba la consulta al prepararla, así que tocar
    // en el fondo el cobro de un trabajo daba error y no enseñaba nada.
    //
    // Por eso no se prueba «un apunte»: se piden TODOS los que haya, con sus
    // cuatro orígenes distintos, que es lo que hace quien está delante.
    console.log('\n=== Los cargos: se pueden quitar, con sus frenos ===');
    const cargos1 = (await pedir('/api/cargos')).cuerpo;
    const admin = cargos1.cargos.find(c => c.es_admin);
    comp('el cargo de administrador está', !!admin);
    comp('y no se puede quitar', (await quitar('/api/cargos/' + admin.id)).status === 400);

    const nuevo = await post('/api/cargos', { nombre: 'Cargo de prueba', permisos: ['vender'] });
    comp('se crea un cargo', nuevo.status === 200 && !!nuevo.cuerpo.id);
    const baja = await quitar('/api/cargos/' + nuevo.cuerpo.id);
    comp('y se puede quitar', baja.status === 200, JSON.stringify(baja.cuerpo));
    comp('ya no sale en la lista',
      !(await pedir('/api/cargos')).cuerpo.cargos.some(c => c.id === nuevo.cuerpo.id));
    comp('y quitarlo dos veces contesta que ya no está',
      (await quitar('/api/cargos/' + nuevo.cuerpo.id)).status === 404);

    // La lápida tiene que viajar. Si la fila desapareciera, el cargo volvería
    // del otro lado en cuanto se juntaran dos copias.
    const paquete = (await pedir('/api/sync/paquete')).cuerpo;
    const enElPaquete = ((paquete.datos || {}).cargos || [])
      .find(c => c.id === nuevo.cuerpo.id);
    comp('la baja viaja en la sincronización', !!enElPaquete && !!enElPaquete.borrado_en,
      JSON.stringify(enElPaquete));

    const conGente = await post('/api/cargos', { nombre: 'Vendedor', permisos: ['vender'] });
    await post('/api/personas', { nombre: 'Ana', usuario: 'ana', pin: '4321',
      cargo_id: conGente.cuerpo.id, sitio_id: centro });
    const conPersona = await quitar('/api/cargos/' + conGente.cuerpo.id);
    comp('un cargo que alguien tiene puesto no se va', conPersona.status === 400);
    comp('y se dice quién lo tiene, para poder cambiárselo',
      /Ana/.test(conPersona.cuerpo.error || ''), conPersona.cuerpo.error);
    comp('el cargo sigue estando',
      (await pedir('/api/cargos')).cuerpo.cargos.some(c => c.id === conGente.cuerpo.id));


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
