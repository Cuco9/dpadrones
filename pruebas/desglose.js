// La tarjeta de Dinero como ESTADO DE CUENTA, y de qué está hecho cada renglón.
//
// Nace de dos preguntas que la pantalla no contestaba (31-ago-2026). Filtrando
// un día se veía «entraron 130 CUP y 176 USD, salieron 4 638 y 1 000», y con eso
// delante todavía faltaban dos cosas.
//
//   1. EN QUÉ QUEDA LA CAJA. El número grande decía «saldo» y eso se lee como
//      el dinero que hay; cambiarle el rótulo evita el malentendido, pero no
//      contesta la pregunta. Ahora la tarjeta es
//         tenía al empezar + lo que entró − lo que salió = quedó al terminar.
//      Y ojo con el atajo que parece obvio y es justo el que no vale:
//      sumarle al efectivo de HOY lo que se movió un día pasado cuenta ese día
//      dos veces, porque el efectivo de hoy ya lo lleva dentro. Lo que se suma
//      es lo que había la VÍSPERA. Aquí se comprueba con números a mano.
//
//   2. DE QUÉ ESTÁ HECHO CADA RENGLÓN. «Ingresos por ventas 166 USD»: ¿cuáles
//      ventas, de qué productos, a cómo? Cada renglón se abre y enseña sus
//      apuntes, y cada venta lo que llevaba dentro.
//
// Lo que se comprueba, y que ninguna otra prueba miraba:
//
//   · que «tenía al empezar» es el saldo de la víspera y no el de hoy;
//   · que los tres números de la tarjeta cuadran entre ellos en cualquier
//     período, y que el de terminar un día es el de empezar el siguiente;
//   · que el desglose de CADA concepto suma exactamente el renglón que hay
//     encima —es el punto entero: dos consultas distintas para el mismo
//     número, y si no coinciden, el desglose miente o el renglón miente—;
//   · que una venta trae sus productos con la cantidad al derecho (en el
//     almacén se guarda en negativo) y que las líneas suman lo que entró;
//   · que un apunte anulado y su contrario SALEN en el desglose, tachados,
//     porque los dos cuentan arriba y esconderlos descuadraría la suma;
//   · y que quien solo manda en su tienda no puede pedir el desglose de otra,
//     ni el del dinero de la empresa, ni colar el total del negocio entero.
//
//   node pruebas/desglose.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const raiz = path.join(__dirname, '..');
const patio = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-desglose-'));

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
const como = t => ({ Authorization: 'Bearer ' + t });
const getComo = (t, ruta) => pedir(ruta, { headers: como(t) });

// Sembrar sin mirar el status miente: el servidor puede rechazar un apunte con
// toda la razón —no se saca de una caja lo que no tiene dentro (#38)— y la
// prueba seguiría midiendo un día que nunca ocurrió. Copiado de filtros.js, que
// es donde se aprendió por las malas.
async function debe(ruta, cuerpo, queEs) {
  const r = await post(ruta, cuerpo);
  if (r.status !== 200) throw new Error('no se pudo sembrar ' + queEs + ': ' +
    r.status + ' ' + JSON.stringify(r.cuerpo));
  return r.cuerpo;
}

// Días fijos y del pasado, nunca relativos a hoy: una prueba apoyada en «hoy» se
// rompe sola el día 1 de cada mes y nadie sabe si falló la aplicación.
const D0 = '2026-02-01';   // el fondo con que se empieza
const D1 = '2026-03-10';
const D2 = '2026-03-11';
const D3 = '2026-03-12';

async function negocio(desde, hasta) {
  const r = await pedir('/api/negocio?desde=' + desde + '&hasta=' + hasta);
  if (r.status !== 200) throw new Error('/api/negocio dio ' + r.status +
    ' ' + JSON.stringify(r.cuerpo));
  return r.cuerpo;
}
const filaDe = (neg, sitio) => (neg.sitios || []).find(s => s.sitio_id === sitio) || null;

// Los tres números de la tarjeta, calculados como los calcula tarjetaDeSitio en
// app.js. Se copia la fórmula a propósito: si el día de mañana alguien cambia
// una y no la otra, esta prueba lo dice.
const entroMenosSalio = (f, m) => f.fondo[m].ingreso + f.fondo[m].recibido -
  f.fondo[m].retiro - f.fondo[m].inversion - f.fondo[m].gasto - f.fondo[m].mandado;
const quedoAlTerminar = (f, m) => f.gaveta_inicio[m] + entroMenosSalio(f, m);

async function desglose(concepto, sitio, desde, hasta, token) {
  const ruta = '/api/negocio/desglose?concepto=' + concepto + '&sitio_id=' + sitio +
    '&desde=' + desde + '&hasta=' + hasta;
  return token ? getComo(token, ruta) : pedir(ruta);
}

// Los ocho conceptos que la tarjeta enseña como renglón, cada uno con el campo
// del que sale su cifra. Es la lista de DESGLOSE en server.js, y la prueba
// recorre las dos a la vez.
const RENGLONES = ['de_ventas', 'de_otros', 'recibido',
                   'retiro', 'inversion', 'gasto', 'mandado'];

(async () => {
  try {
    const PUERTO = await puertoLibre();
    BASE = 'http://127.0.0.1:' + PUERTO;
    await arrancar({ PUERTO, DP_DB: path.join(patio, 'app.db'), DP_HTTP: '1' },
                   /D´Padrones/);

    console.log('\n=== Preparar: dos sitios, dos productos y el dólar puesto ===');
    await post('/api/auth/crear-admin', { nombre: 'Jefe', usuario: 'jefe', pin: '1234' });
    const ses = await post('/api/auth/entrar', { usuario: 'jefe', pin: '1234' });
    cab = { Authorization: 'Bearer ' + ses.cuerpo.token };
    const almacen = (await pedir('/api/sitios')).cuerpo[0].id;
    const tienda = (await post('/api/sitios',
      { nombre: 'Tienda Centro', tipo: 'punto', padre_id: almacen })).cuerpo.id;
    await debe('/api/tasa', { tasa: 400 }, 'el valor del dolar');
    const tela = (await post('/api/productos', { nombre: 'Tela', precio: 50,
      precio_moneda: 'USD', costo: 6000, um: 'Metro' })).cuerpo.id;
    const camisa = (await post('/api/productos', { nombre: 'Camisa', precio: 8,
      precio_moneda: 'USD', costo: 1200, um: 'Unidad' })).cuerpo.id;
    await debe('/api/movimientos', { tipo: 'compra', sitio_id: tienda, producto_id: tela,
      cantidad: 500, costo_unit: 6000, fecha: '2026-01-05' }, 'el tela');
    await debe('/api/movimientos', { tipo: 'compra', sitio_id: tienda, producto_id: camisa,
      cantidad: 500, costo_unit: 1200, fecha: '2026-01-05' }, 'los camisas');

    console.log('\n=== El fondo con que se empieza, en febrero ===');
    // Sin dinero dentro, el servidor no deja sacar (#38) y los retiros de marzo
    // no entrarían: la prueba estaría midiendo días que no ocurrieron.
    await debe('/api/fondo', { tipo: 'ingreso', moneda: 'CUP', importe: 80000,
      sitio_id: tienda, concepto: 'Fondo inicial', fecha: D0 }, 'el fondo en CUP');
    await debe('/api/fondo', { tipo: 'ingreso', moneda: 'USD', importe: 500,
      sitio_id: tienda, concepto: 'Fondo inicial en dólares', fecha: D0 }, 'el fondo en USD');
    await debe('/api/fondo', { tipo: 'ingreso', moneda: 'CUP', importe: 200000,
      sitio_id: almacen, concepto: 'Fondo del almacén', fecha: D0 }, 'el fondo del almacén');
    // Y un aporte que NO es de ningún punto: es la fila «De la empresa». Desde el
    // 31-ago-2026 la puerta ya no lo acepta, así que se siembra como lo que es: un
    // apunte heredado (ver apunteHeredadoSinSitio, abajo).
    apunteHeredadoSinSitio(path.join(patio, 'app.db'), {
      tipo: 'ingreso', moneda: 'CUP', importe: 5000,
      concepto: 'Aporte de socio', fecha: D0 });

    console.log('\n=== Un día con las cuatro cosas: ventas, otros, retiros y gastos ===');
    // Es el día 26 de la foto, con sus mismos números: entran 130 CUP y 176 USD
    // (166 de ventas + 10 apuntados a mano), salen 4 638 de retiro y 1 000 de
    // gasto. Se copian a propósito, para poder mirar la prueba y la foto juntas.
    const v1 = await debe('/api/ventas', { sitio_id: tienda, moneda: 'USD', fecha: D1,
      lineas: [{ producto_id: tela, cantidad: 2 }] }, 'la venta de tela');   // 2 × 50 = 100
    const v2 = await debe('/api/ventas', { sitio_id: tienda, moneda: 'USD', fecha: D1,
      lineas: [{ producto_id: camisa, cantidad: 2 },                            // 2 × 8  =  16
               { producto_id: tela, cantidad: 1 }] }, 'la venta mezclada');   // 1 × 50 =  50
    await debe('/api/fondo', { tipo: 'ingreso', moneda: 'CUP', importe: 130,
      sitio_id: tienda, concepto: 'Cobro atrasado', fecha: D1 }, 'el ingreso en CUP');
    await debe('/api/fondo', { tipo: 'ingreso', moneda: 'USD', importe: 10,
      sitio_id: tienda, concepto: 'Vuelto que sobró', fecha: D1 }, 'el ingreso en USD');
    await debe('/api/fondo', { tipo: 'retiro', moneda: 'CUP', importe: 4638,
      sitio_id: tienda, concepto: 'Reparto del día', fecha: D1 }, 'el retiro');
    await debe('/api/fondo', { tipo: 'gasto', moneda: 'CUP', importe: 1000,
      sitio_id: tienda, concepto: 'Transporte', fecha: D1 }, 'el gasto');
    comp('sembrado el día de la foto', !!v1.id && !!v2.id);

    const d1 = filaDe(await negocio(D1, D1), tienda);
    comp('ese día entraron 166 USD de ventas', d1.fondo.USD.de_ventas === 166,
      d1.fondo.USD.de_ventas);
    comp('y 130 CUP + 10 USD de otros ingresos',
      d1.fondo.CUP.de_otros === 130 && d1.fondo.USD.de_otros === 10,
      d1.fondo.CUP.de_otros + ' / ' + d1.fondo.USD.de_otros);
    comp('salieron 4 638 de retiro y 1 000 de gasto',
      d1.fondo.CUP.retiro === 4638 && d1.fondo.CUP.gasto === 1000,
      JSON.stringify(d1.fondo.CUP));

    console.log('\n=== «Tenía al empezar» es la víspera, NO el efectivo de hoy ===');
    // El corazón del asunto. La caja de la tienda tenía 80 000 al empezar el día
    // de la foto (lo de febrero, y nada más). Sumarle a esa cifra lo del día da
    // lo que quedó esa noche. Sumárselo al efectivo de HOY sería contar el día
    // dos veces, que es lo que no se ha hecho.
    comp('tenía 80 000 CUP al empezar el día', d1.gaveta_inicio.CUP === 80000,
      d1.gaveta_inicio.CUP);
    comp('y 500 USD', d1.gaveta_inicio.USD === 500, d1.gaveta_inicio.USD);
    comp('entró menos salió da -5 508 CUP y +176 USD, como en la foto',
      entroMenosSalio(d1, 'CUP') === -5508 && entroMenosSalio(d1, 'USD') === 176,
      entroMenosSalio(d1, 'CUP') + ' / ' + entroMenosSalio(d1, 'USD'));
    comp('y quedó al terminar 74 492 CUP + 676 USD',
      quedoAlTerminar(d1, 'CUP') === 74492 && quedoAlTerminar(d1, 'USD') === 676,
      quedoAlTerminar(d1, 'CUP') + ' / ' + quedoAlTerminar(d1, 'USD'));
    comp('«tenía al empezar» NO es el efectivo de hoy: ese ya lleva el día dentro',
      d1.gaveta_inicio.CUP !== d1.gaveta.CUP, d1.gaveta_inicio.CUP + ' vs ' + d1.gaveta.CUP);

    console.log('\n=== Lo que quedó una noche es lo que había a la mañana siguiente ===');
    // Dos días más, para poder encadenar tres cierres. Si un día se contara dos
    // veces o ninguna, la cadena se rompería justo aquí.
    await debe('/api/fondo', { tipo: 'gasto', moneda: 'CUP', importe: 300,
      sitio_id: tienda, concepto: 'Bolsas', fecha: D2 }, 'el gasto del día 2');
    await debe('/api/ventas', { sitio_id: tienda, moneda: 'CUP', fecha: D3,
      lineas: [{ producto_id: camisa, cantidad: 1 }] }, 'la venta del día 3');
    const f1 = filaDe(await negocio(D1, D1), tienda);
    const f2 = filaDe(await negocio(D2, D2), tienda);
    const f3 = filaDe(await negocio(D3, D3), tienda);
    for (const m of ['CUP', 'USD']) {
      comp('en ' + m + ', el día 2 empieza con lo que dejó el día 1',
        f2.gaveta_inicio[m] === quedoAlTerminar(f1, m),
        f2.gaveta_inicio[m] + ' vs ' + quedoAlTerminar(f1, m));
      comp('en ' + m + ', el día 3 empieza con lo que dejó el día 2',
        f3.gaveta_inicio[m] === quedoAlTerminar(f2, m),
        f3.gaveta_inicio[m] + ' vs ' + quedoAlTerminar(f2, m));
    }

    console.log('\n=== Mirándolo TODO, lo que quedó es el efectivo que hay ===');
    // Desde el principio de los tiempos hasta el final: no hay víspera (empieza
    // en cero) y lo que quedó tiene que ser exactamente lo que hay en la gaveta.
    // Es la comprobación que ata las dos cifras y que impide que se separen.
    const todo = await negocio('0000-01-01', '9999-12-31');
    for (const p of (todo.sitios || []).concat([todo.total])) {
      for (const m of ['CUP', 'USD']) {
        comp('en ' + (p.sitio || 'el total') + ' / ' + m +
             ', sin víspera se empieza en cero', p.gaveta_inicio[m] === 0, p.gaveta_inicio[m]);
        comp('en ' + (p.sitio || 'el total') + ' / ' + m +
             ', lo que quedó es el efectivo que hay',
          Math.abs(quedoAlTerminar(p, m) - p.gaveta[m]) < 0.005,
          quedoAlTerminar(p, m) + ' vs ' + p.gaveta[m]);
      }
    }
    // Y el rango de tres días: empezar + moverse = lo que hay hoy, porque después
    // del día 3 no se movió nada más.
    const tres = filaDe(await negocio(D1, D3), tienda);
    comp('el rango entero de la tienda cierra con lo que hay en su caja',
      quedoAlTerminar(tres, 'CUP') === tres.gaveta.CUP &&
      quedoAlTerminar(tres, 'USD') === tres.gaveta.USD,
      quedoAlTerminar(tres, 'CUP') + ' vs ' + tres.gaveta.CUP);
    comp('y «tenía al empezar» del total es la suma de sus filas',
      Math.abs(todo.total.gaveta_inicio.CUP -
        (todo.sitios || []).reduce((s, p) => s + p.gaveta_inicio.CUP, 0)) < 0.005);

    console.log('\n=== Un traspaso y una compra, para llenar los otros renglones ===');
    await debe('/api/fondo/traspaso', { origen_id: almacen, destino_id: tienda,
      moneda: 'CUP', importe: 7000, fecha: D2 }, 'el traspaso');
    // La inversión NO se apunta a mano en el fondo: es una compra de mercancía
    // con sus líneas, y el apunte del dinero lo pone ella al registrarse. Su
    // «sitio_id» es de qué gaveta sale (#38).
    const inv = await debe('/api/inversiones', { nombre: 'Compra de tela',
      proveedor: 'Importadora XY', moneda: 'CUP', fecha: D2, sitio_id: tienda,
      lineas: [{ producto_id: tela, cantidad: 5, costo_unit: 500 }] }, 'la inversión');
    await debe('/api/inversiones/' + inv.id + '/registrar', {}, 'registrar la inversión');

    console.log('\n=== Cada renglón suma EXACTAMENTE lo que dice su desglose ===');
    // El punto entero de todo esto. La tarjeta suma el renglón con una consulta y
    // el desglose con otra: si las dos no dan el mismo número, o el renglón miente
    // o miente el desglose, y no habría forma de saber cuál.
    for (const [nombre, sitio, clave] of
         [['la tienda', tienda, tienda], ['el almacén', almacen, almacen]]) {
      const fila = filaDe(await negocio(D0, D3), sitio);
      for (const c of RENGLONES) {
        const r = await desglose(c, clave, D0, D3);
        comp('en ' + nombre + ', «' + c + '» cuadra con su desglose',
          r.status === 200 &&
          Math.abs(r.cuerpo.total.CUP - fila.fondo.CUP[c]) < 0.005 &&
          Math.abs(r.cuerpo.total.USD - fila.fondo.USD[c]) < 0.005,
          JSON.stringify(r.cuerpo.total) + ' vs ' +
          JSON.stringify({ CUP: fila.fondo.CUP[c], USD: fila.fondo.USD[c] }));
      }
    }
    // Y el total del negocio, que es la fila que más fácil se descuadra: incluye
    // la de «De la empresa», que no es ningún sitio.
    const filaTotal = (await negocio(D0, D3)).total;
    for (const c of RENGLONES) {
      const r = await desglose(c, '*', D0, D3);
      comp('en el TOTAL, «' + c + '» cuadra con su desglose',
        r.status === 200 &&
        Math.abs(r.cuerpo.total.CUP - filaTotal.fondo.CUP[c]) < 0.005 &&
        Math.abs(r.cuerpo.total.USD - filaTotal.fondo.USD[c]) < 0.005,
        JSON.stringify(r.cuerpo.total) + ' vs ' +
        JSON.stringify({ CUP: filaTotal.fondo.CUP[c], USD: filaTotal.fondo.USD[c] }));
    }
    // La fila «De la empresa» tiene su propia clave, que no es un id de sitio.
    const empresa = (await negocio(D0, D3)).sitios.find(p => p.sitio_id === null);
    const rEmpresa = await desglose('de_otros', '-', D0, D3);
    comp('la fila «De la empresa» se abre con su propia clave',
      rEmpresa.status === 200 && rEmpresa.cuerpo.total.CUP === empresa.fondo.CUP.de_otros,
      rEmpresa.status + ' ' + JSON.stringify(rEmpresa.cuerpo.total));
    comp('y trae el aporte del socio, que no entró por ninguna tienda',
      (rEmpresa.cuerpo.apuntes || []).some(a => /Aporte de socio/.test(a.concepto || '')),
      JSON.stringify((rEmpresa.cuerpo.apuntes || []).map(a => a.concepto)));

    console.log('\n=== Y los apuntes que se enseñan suman ese mismo total ===');
    // Con pocos apuntes no hay corte, así que la lista tiene que sumar el total.
    // Si algún día se cortara, «hay_mas» lo avisaría y esta comprobación no
    // valdría: por eso se mira antes.
    for (const c of RENGLONES) {
      const r = (await desglose(c, tienda, D0, D3)).cuerpo;
      if (!r.apuntes.length) continue;
      const suma = m => r.apuntes.filter(a => a.moneda === m)
        .reduce((s, a) => s + a.importe, 0);
      comp('los apuntes de «' + c + '» suman su propio total',
        !r.hay_mas && Math.abs(suma('CUP') - r.total.CUP) < 0.005 &&
        Math.abs(suma('USD') - r.total.USD) < 0.005,
        JSON.stringify({ lista: [suma('CUP'), suma('USD')], total: r.total }));
    }

    console.log('\n=== Una venta enseña lo que llevaba dentro ===');
    const ventas = (await desglose('de_ventas', tienda, D1, D1)).cuerpo;
    comp('el día de la foto tuvo dos ventas', ventas.apuntes.length === 2,
      ventas.apuntes.length);
    const mezclada = ventas.apuntes.find(a => a.ref_id === v2.id);
    comp('la venta de dos productos trae sus dos líneas',
      mezclada && mezclada.de && mezclada.de.lineas.length === 2,
      mezclada && mezclada.de && JSON.stringify(mezclada.de.lineas));
    // En el almacén una venta se guarda en NEGATIVO: es mercancía que salió. En
    // un desglose de lo que se vendió se lee al derecho, o «-3 camisas» se
    // entiende como una devolución.
    const camisas = mezclada.de.lineas.find(l => /Camisa/.test(l.nombre));
    comp('la cantidad sale al derecho, no en negativo',
      camisas.cantidad === 2, camisas.cantidad);
    comp('con su unidad de medida y su precio', camisas.um === 'Unidad' &&
      camisas.precio_unit === 8, camisas.um + ' / ' + camisas.precio_unit);
    comp('y su importe es cantidad por precio', camisas.importe === 16, camisas.importe);
    comp('las líneas suman lo que entró por esa venta',
      Math.abs(mezclada.de.lineas.reduce((s, l) => s + l.importe, 0) -
               Math.abs(mezclada.importe)) < 0.005,
      mezclada.de.lineas.reduce((s, l) => s + l.importe, 0) + ' vs ' + mezclada.importe);
    comp('la otra venta trae su única línea de 2 metros de tela',
      (() => { const a = ventas.apuntes.find(x => x.ref_id === v1.id);
               return a && a.de.lineas.length === 1 && a.de.lineas[0].cantidad === 2; })(),
      JSON.stringify((ventas.apuntes.find(x => x.ref_id === v1.id) || {}).de));

    console.log('=== Un traspaso dice con qué caja fue ===');
    const recibido = (await desglose('recibido', tienda, D2, D2)).cuerpo;
    comp('lo recibido trae su apunte', recibido.apuntes.length === 1, recibido.apuntes.length);
    comp('y dice de qué caja vino',
      recibido.apuntes[0].de && /Almacén/.test(recibido.apuntes[0].de.otra_caja || ''),
      JSON.stringify(recibido.apuntes[0].de));
    const mandado = (await desglose('mandado', almacen, D2, D2)).cuerpo;
    comp('y al que lo mandó, a qué caja fue',
      mandado.apuntes.length === 1 && /Tienda/.test(mandado.apuntes[0].de.otra_caja || ''),
      JSON.stringify((mandado.apuntes[0] || {}).de));

    console.log('\n=== Un apunte anulado SALE, tachado, y la suma sigue cuadrando ===');
    // Aquí el desglose hace lo contrario que la lista de Movimientos, y a
    // propósito: allí el error y su corrección estorban, aquí hacen falta porque
    // el renglón de arriba los cuenta a los dos.
    const lista = (await pedir('/api/fondo?desde=' + D1 + '&hasta=' + D1)).cuerpo;
    const elGasto = (lista.movimientos || []).find(m => m.concepto === 'Transporte');
    comp('se encuentra el gasto que se va a anular', !!elGasto);
    await post('/api/fondo/' + elGasto.id + '/anular', {});
    const trasAnular = filaDe(await negocio(D1, D1), tienda);
    comp('el renglón del gasto vuelve a cero', trasAnular.fondo.CUP.gasto === 0,
      trasAnular.fondo.CUP.gasto);
    const dg = (await desglose('gasto', tienda, D1, D1)).cuerpo;
    comp('pero el desglose enseña los dos apuntes, el error y la resta',
      dg.apuntes.length === 2, dg.apuntes.length);
    comp('uno marcado como anulado y el otro como la anulación',
      dg.apuntes.some(a => a.anulado) && dg.apuntes.some(a => a.anula_a),
      JSON.stringify(dg.apuntes.map(a => ({ anulado: a.anulado, anula: !!a.anula_a }))));
    comp('y entre los dos suman cero, igual que el renglón',
      dg.total.CUP === 0 && trasAnular.fondo.CUP.gasto === 0,
      dg.total.CUP + ' vs ' + trasAnular.fondo.CUP.gasto);

    console.log('\n=== Un ingreso tambien dice en que caja entra (31-ago-2026) ===');
    // El dueno quito «Ninguno en concreto» de la pantalla de Ingresos. Lo que
    // manda es el servidor: esconder la opcion en la pantalla es decoracion (#10).
    const sinSitio = await post('/api/fondo', { tipo: 'ingreso', moneda: 'CUP',
      importe: 700, concepto: 'Aporte sin decir donde', fecha: D3 });
    comp('un ingreso sin caja se rechaza', sinSitio.status === 400,
      sinSitio.status + ' ' + JSON.stringify(sinSitio.cuerpo));
    comp('y se dice por que, no un codigo',
      /en qu[eé] caja entra/i.test(sinSitio.cuerpo.error || ''), sinSitio.cuerpo.error);
    const conSitio = await post('/api/fondo', { tipo: 'ingreso', moneda: 'CUP',
      importe: 700, sitio_id: tienda, concepto: 'Aporte de un socio', fecha: D3 });
    comp('con caja entra sin problema', conSitio.status === 200,
      conSitio.status + ' ' + JSON.stringify(conSitio.cuerpo));
    // Y ENTRAR no es SACAR: se puede ingresar en una caja aunque este vacia. Si
    // el ingreso se hubiera metido en la lista de «sale de una caja» (#38), esto
    // daria 400 y no se podria poner dinero en una tienda nueva.
    const nueva = (await post('/api/sitios',
      { nombre: 'Punto Nuevo', tipo: 'punto', padre_id: almacen })).cuerpo.id;
    const enVacia = await post('/api/fondo', { tipo: 'ingreso', moneda: 'CUP',
      importe: 300, sitio_id: nueva, concepto: 'Fondo para empezar', fecha: D3 });
    comp('y se puede ingresar en una caja vacia, que es como se abre una tienda',
      enVacia.status === 200, enVacia.status + ' ' + JSON.stringify(enVacia.cuerpo));
    // El apunte HEREDADO sigue contando: el pasado no se reescribe (#2).
    const conHeredado = filaDe(await negocio('0000-01-01', '9999-12-31'), null);
    comp('y el apunte viejo sin sitio sigue en la fila «De la empresa»',
      !!conHeredado && conHeredado.fondo.CUP.de_otros === 5000,
      conHeredado && conHeredado.fondo.CUP.de_otros);

    console.log('\n=== Un concepto inventado no se contesta ===');
    const raro = await desglose('lo_que_sea', tienda, D0, D3);
    comp('pedir un concepto que no existe da 400 y no una lista vacía',
      raro.status === 400, raro.status + ' ' + JSON.stringify(raro.cuerpo));
    // Y que no se pueda colar un trozo de SQL por ahí: el concepto no se pega a
    // la consulta, se busca en una lista cerrada.
    const inyecta = await desglose(encodeURIComponent("gasto' OR '1'='1"), tienda, D0, D3);
    comp('ni uno con SQL dentro', inyecta.status === 400, inyecta.status);

    console.log('\n=== Quien manda en su tienda no ve la caja de la otra ===');
    const encargada = (await post('/api/cargos', { nombre: 'Encargada de tienda',
      permisos: ['ver_fondo', 'ver_informes', 'ver_ventas'] })).cuerpo.id;
    await post('/api/personas', { nombre: 'Rosa', usuario: 'rosa', pin: '6666',
      cargo_id: encargada, sitio_id: tienda });
    const tRosa = (await post('/api/auth/entrar', { usuario: 'rosa', pin: '6666' })).cuerpo.token;

    const suyo = await desglose('de_ventas', tienda, D0, D3, tRosa);
    comp('el desglose de SU tienda se le abre', suyo.status === 200,
      suyo.status + ' ' + JSON.stringify(suyo.cuerpo).slice(0, 120));
    const ajeno = await desglose('de_ventas', almacen, D0, D3, tRosa);
    comp('el del almacén se le niega', ajeno.status === 403, ajeno.status);
    const deLaEmpresa = await desglose('de_otros', '-', D0, D3, tRosa);
    comp('y el dinero que no es de ningún punto, también', deLaEmpresa.status === 403,
      deLaEmpresa.status);
    // El total tiene que darle SU total, no el del negocio: es donde más fácil se
    // escapa el dinero de los demás, porque la petición se ve inocente.
    const suTotal = await desglose('de_otros', '*', D0, D3, tRosa);
    const elDeTodos = await desglose('de_otros', '*', D0, D3);
    comp('el «total» que se le enseña es el de sus locales', suTotal.status === 200 &&
      suTotal.cuerpo.total.CUP < elDeTodos.cuerpo.total.CUP,
      suTotal.cuerpo.total.CUP + ' vs ' + elDeTodos.cuerpo.total.CUP);
    comp('y ni un apunte suyo es de otro sitio',
      (suTotal.cuerpo.apuntes || []).every(a => !a.sitio || /Tienda/.test(a.sitio)),
      JSON.stringify((suTotal.cuerpo.apuntes || []).map(a => a.sitio)));
    comp('tampoco el aporte del socio, que no es de ninguna tienda',
      !(suTotal.cuerpo.apuntes || []).some(a => /Aporte de socio/.test(a.concepto || '')));
    // Y su tarjeta cuadra igual que la del jefe: mismo estado de cuenta, con lo
    // suyo. Si «tenía al empezar» se le calculara sin filtrar, vería el dinero
    // del almacén metido en su víspera.
    const suNeg = (await getComo(tRosa, '/api/negocio?desde=' + D1 + '&hasta=' + D1)).cuerpo;
    const suFila = (suNeg.sitios || [])[0];
    comp('a ella se le enseña una sola fila, la suya',
      (suNeg.sitios || []).length === 1 && suFila.sitio_id === tienda,
      JSON.stringify((suNeg.sitios || []).map(p => p.sitio)));
    comp('con el mismo «tenía al empezar» que ve el jefe de esa tienda',
      suFila.gaveta_inicio.CUP === 80000, suFila.gaveta_inicio.CUP);
    comp('y su total no lleva dentro el fondo del almacén',
      suNeg.total.gaveta_inicio.CUP === 80000, suNeg.total.gaveta_inicio.CUP);

    console.log('\n=== Sin permiso sobre el dinero, no hay desglose ===');
    // Quien entra a la pantalla por «ver_informes» recibe la tarjeta sin gavetas
    // (#10: lo que no se puede ver, no sale del servidor). Tampoco puede
    // preguntar de qué está hecho un renglón que no se le enseña.
    const soloInformes = (await post('/api/cargos', { nombre: 'Solo informes',
      permisos: ['ver_informes'] })).cuerpo.id;
    await post('/api/personas', { nombre: 'Tito', usuario: 'tito', pin: '7777',
      cargo_id: soloInformes });
    const tTito = (await post('/api/auth/entrar', { usuario: 'tito', pin: '7777' })).cuerpo.token;
    const negTito = (await getComo(tTito, '/api/negocio?desde=' + D1 + '&hasta=' + D1)).cuerpo;
    comp('a él la tarjeta le llega sin gavetas y sin víspera',
      (negTito.sitios || []).every(p => p.gaveta === null && p.gaveta_inicio === null),
      JSON.stringify((negTito.sitios || []).map(p => p.gaveta_inicio)));
    const dgTito = await desglose('de_ventas', tienda, D1, D1, tTito);
    comp('y el desglose se le niega', dgTito.status === 403, dgTito.status);

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

// Un apunte de ANTES del 31 de agosto de 2026, cuando un ingreso a mano todavia
// podia no llevar sitio. Desde ese dia la puerta lo rechaza —el dueno pidio
// quitar «Ninguno en concreto»— pero los que YA estaban escritos siguen ahi y
// siguen sumando en la fila «De la empresa»: el pasado no se reescribe (#2).
//
// Se escribe directo en la base a proposito, porque es exactamente lo que es: un
// registro heredado, no algo que la aplicacion pueda crear hoy. Sembrarlo por la
// puerta seria pedirle que acepte lo que acaba de prohibir.
function apunteHeredadoSinSitio(rutaDB, campos) {
  const Database = require('better-sqlite3');
  const d = new Database(rutaDB);
  try {
    const ahora = new Date().toISOString();
    d.prepare(`INSERT INTO fondo
        (id,tipo,subtipo,moneda,importe,sitio_id,persona_id,beneficiario_id,es_gente,
         concepto,ref_tipo,ref_id,anula_a,fecha,ts,creado_en)
        VALUES (?,?,?,?,?,NULL,NULL,NULL,0,?,NULL,NULL,NULL,?,?,?)`)
      .run('heredado-' + Math.random().toString(36).slice(2, 10),
           campos.tipo, campos.subtipo || null,
           campos.moneda === 'USD' ? 'USD' : 'CUP', campos.importe,
           campos.concepto || '', campos.fecha, Date.now(), ahora);
  } finally { d.close(); }
}
