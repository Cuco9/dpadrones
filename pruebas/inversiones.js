// Inversiones: se compra mercancía, se reparte entre los sitios,
// se vende y se mira cuánto se ha
// recuperado del costo y cuánto es ganancia.
//
// Se arranca el servidor de verdad contra una base de datos de usar y tirar. Lo
// que se comprueba aquí no son las funciones sueltas: es que las cuentas salgan
// bien cuando las cosas pasan en el orden en que pasan de verdad.
//
//   node pruebas/inversiones.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const raiz = path.join(__dirname, '..');
const patio = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-inv-'));

let ok = 0, mal = 0;
const comp = (nombre, cierto, extra) => {
  if (cierto) { ok++; console.log('  ok   ' + nombre); }
  else { mal++; console.log('  MAL  ' + nombre + (extra !== undefined ? '  → ' + extra : '')); }
};

// Un puerto que se le pide al sistema: con uno fijo, un servidor que quedó vivo
// de la pasada anterior bloquea la siguiente y el fallo sale como «fetch failed».
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
const dia = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
// El stock llega como {stock: {producto_id: cantidad}}
const stock = async (sitio, producto) =>
  ((await pedir('/api/stock?sitio_id=' + sitio)).cuerpo.stock || {})[producto] || 0;

(async () => {
  try {
    const PUERTO = await puertoLibre();
    BASE = 'http://127.0.0.1:' + PUERTO;
    // Sin candado: lo que el candado protege ya se prueba en pruebas/certificados.js,
    // y fabricar los certificados haría esta prueba tres veces más lenta.
    await arrancar({ PUERTO, DP_DB: path.join(patio, 'app.db'), DP_HTTP: '1',
                     DP_SALVAS: path.join(patio, 'salvas'), DP_SALVAS_GUARDAR: '3' },
                   /D´Padrones/);

    console.log('\n=== Preparar: administrador, dos sitios y catálogo ===');
    await post('/api/auth/crear-admin', { nombre: 'Jefe', usuario: 'jefe', pin: '1234' });
    const ses = await post('/api/auth/entrar', { usuario: 'jefe', pin: '1234' });
    cab = { Authorization: 'Bearer ' + ses.cuerpo.token };
    comp('se entra con el PIN', !!ses.cuerpo.token, JSON.stringify(ses.cuerpo));

    await post('/api/tasa', { tasa: 400 });
    // El «Almacén Principal» que siembra la aplicación es el MIRADOR: desde ahí se
    // ven los totales de todos sumados y no se guarda nada (DECISIONES.md #48).
    // El almacén de verdad, el que tiene la mercancía, se crea aquí.
    const almacen = (await post('/api/sitios',
      { nombre: 'Almacén Central', tipo: 'almacen' })).cuerpo.id;
    const punto = await post('/api/sitios', { nombre: 'Punto Centro', tipo: 'punto', padre_id: almacen });
    comp('se crea el punto de venta', punto.status === 200, JSON.stringify(punto.cuerpo));

    // Dinero en las cajas antes de comprar nada. Desde el 21 de agosto de 2026 no
    // se saca de una gaveta lo que no tiene dentro (DECISIONES.md #38), así que una
    // prueba que compra empieza poniendo el dinero, igual que el negocio de verdad.
    const meter = (sitio, moneda, importe) => post('/api/fondo', { tipo: 'ingreso',
      subtipo: 'Aporte de socio', moneda, importe, sitio_id: sitio,
      concepto: 'Capital para empezar', fecha: dia(60) });
    await meter(almacen, 'USD', 50000);
    await meter(almacen, 'CUP', 5000000);
    await meter(punto.cuerpo.id, 'USD', 50000);
    await meter(punto.cuerpo.id, 'CUP', 5000000);
    // Y un aporte que NO entra por ninguna tienda, que es lo que hace que exista la
    // fila «Del negocio». Desde el 31-ago-2026 ya no se puede apuntar así por la
    // puerta; este es de los de antes (ver apunteHeredadoSinSitio, abajo).
    apunteHeredadoSinSitio(path.join(patio, 'app.db'), {
      tipo: 'ingreso', subtipo: 'Aporte de socio', moneda: 'CUP', importe: 1000,
      concepto: 'Aporte de un socio, sin pasar por ninguna tienda', fecha: dia(60) });
    const inv5 = await post('/api/productos', { nombre: 'Inversor 5kW', precio: 500,
      precio_moneda: 'USD', costo: 120000 });
    const cable = await post('/api/productos', { nombre: 'Cable 10mm', precio: 800, costo: 400 });
    const idInv = inv5.cuerpo.id, idCable = cable.cuerpo.id;

    console.log('\n=== La inversión es una lista de productos, y el importe se calcula ===');
    let i = await post('/api/inversiones', {
      nombre: 'Contenedor de agosto', proveedor: 'Importadora XY', moneda: 'USD', fecha: dia(40),
      sitio_id: almacen,
      lineas: [
        { producto_id: idInv, cantidad: 10, costo_unit: 300,
          reparto: [{ sitio_id: almacen, cantidad: 6 }, { sitio_id: punto.cuerpo.id, cantidad: 4 }] },
        { producto_id: idCable, cantidad: 100, costo_unit: 1 },
      ] });
    comp('se guarda el borrador', i.status === 200, JSON.stringify(i.cuerpo));
    const idInversion = i.cuerpo.id;
    comp('lleva número correlativo', /^INV-\d{4}$/.test(i.cuerpo.inversion.numero),
      i.cuerpo.inversion.numero);
    comp('nace en borrador', i.cuerpo.inversion.estado === 'borrador');

    let d = await pedir('/api/inversiones/' + idInversion);
    comp('el importe sale de las líneas: 10×300 + 100×1 = 3 100 USD',
      d.cuerpo.importe === 3100, d.cuerpo.importe);
    comp('y las unidades, 110', d.cuerpo.unidades === 110, d.cuerpo.unidades);

    console.log('\n=== Repartir más de lo comprado se rechaza ===');
    const pasado = await post('/api/inversiones', { id: idInversion, nombre: 'Contenedor de agosto',
      moneda: 'USD', fecha: dia(40), sitio_id: almacen,
      lineas: [{ producto_id: idInv, cantidad: 10, costo_unit: 300,
        reparto: [{ sitio_id: almacen, cantidad: 8 }, { sitio_id: punto.cuerpo.id, cantidad: 5 }] }] });
    comp('no deja repartir 13 de 10', pasado.status === 400, JSON.stringify(pasado.cuerpo));
    comp('y lo dice con palabras, no con un código',
      /repartiendo más/.test(pasado.cuerpo.error || ''), pasado.cuerpo.error);
    // Se deja como estaba
    await post('/api/inversiones', { id: idInversion, nombre: 'Contenedor de agosto',
      proveedor: 'Importadora XY', moneda: 'USD', fecha: dia(40), sitio_id: almacen,
      lineas: [
        { producto_id: idInv, cantidad: 10, costo_unit: 300,
          reparto: [{ sitio_id: almacen, cantidad: 6 }, { sitio_id: punto.cuerpo.id, cantidad: 4 }] },
        { producto_id: idCable, cantidad: 100, costo_unit: 1 },
      ] });

    console.log('\n=== Registrarla mete la mercancía donde toca ===');
    const reg = await post('/api/inversiones/' + idInversion + '/registrar', {});
    comp('se registra', reg.status === 200, JSON.stringify(reg.cuerpo));
    comp('pasa a registrada', reg.cuerpo.inversion.estado === 'registrada');
    comp('6 inversores en el almacén', await stock(almacen, idInv) === 6);
    comp('4 en el punto de venta', await stock(punto.cuerpo.id, idInv) === 4);
    comp('el cable, que no se repartió, se queda entero en el almacén',
      await stock(almacen, idCable) === 100);
    // 300 USD con el dólar a 400 son 120 000 CUP: el inventario va SIEMPRE en CUP
    d = await pedir('/api/inversiones/' + idInversion);
    comp('el costo de la entrada queda en pesos, no en dólares',
      d.cuerpo.compras.some(c => c.costo_cup === 120000),
      JSON.stringify(d.cuerpo.compras.map(c => c.costo_cup)));

    const fondo = (await pedir('/api/fondo')).cuerpo;
    comp('el dinero sale del fondo en dólares',
      fondo.resumen.USD.inversion === 3100, JSON.stringify(fondo.resumen.USD));

    console.log('\n=== Una inversión registrada ya no se toca ===');
    const tocar = await post('/api/inversiones', { id: idInversion, nombre: 'Otra cosa',
      moneda: 'USD', lineas: [] });
    comp('se niega a cambiarla', tocar.status === 409, JSON.stringify(tocar.cuerpo));

    console.log('\n=== Vender recupera costo, y lo que sobra es ganancia ===');
    // Precio del inversor: 500 USD. Costo de la inversión: 300 USD.
    let v = await post('/api/ventas', { sitio_id: punto.cuerpo.id, moneda: 'USD', fecha: dia(20),
      lineas: [{ producto_id: idInv, cantidad: 2 }] });
    comp('se venden 2 inversores por 1 000 USD', v.cuerpo.total === 1000, JSON.stringify(v.cuerpo));

    d = await pedir('/api/inversiones/' + idInversion);
    comp('se recuperan 600 USD de costo (2×300)', d.cuerpo.costo_recuperado === 600,
      d.cuerpo.costo_recuperado);
    comp('y 400 USD son ganancia (2×200)', d.cuerpo.extra === 400, d.cuerpo.extra);
    comp('va por el 19,4% del costo', d.cuerpo.pct_costo === 19.4, d.cuerpo.pct_costo);
    comp('2 unidades vendidas de 110', d.cuerpo.unidades_vendidas === 2, d.cuerpo.unidades_vendidas);

    console.log('\n=== Una venta en la otra moneda se pasa con la tasa ===');
    v = await post('/api/ventas', { sitio_id: almacen, moneda: 'CUP', fecha: dia(15),
      lineas: [{ producto_id: idInv, cantidad: 1 }] });
    comp('se vende 1 en pesos: 200 000 CUP', v.cuerpo.total === 200000, JSON.stringify(v.cuerpo));
    d = await pedir('/api/inversiones/' + idInversion);
    comp('900 USD de costo recuperado (3×300)', d.cuerpo.costo_recuperado === 900,
      d.cuerpo.costo_recuperado);
    comp('600 USD de ganancia (500 CUP→USD son 200 por unidad)', d.cuerpo.extra === 600,
      d.cuerpo.extra);
    comp('lo que entró se enseña sin convertir, cada moneda por su lado',
      d.cuerpo.entrado.USD === 1000 && d.cuerpo.entrado.CUP === 200000,
      JSON.stringify(d.cuerpo.entrado));

    console.log('\n=== La merma gasta unidades pero no recupera nada ===');
    await post('/api/movimientos', { tipo: 'merma', sitio_id: almacen, producto_id: idCable,
      cantidad: 10, motivo: 'Rotura', fecha: dia(14) });
    d = await pedir('/api/inversiones/' + idInversion);
    comp('las 10 unidades rotas se apuntan aparte, como merma',
      d.cuerpo.unidades_perdidas === 10, d.cuerpo.unidades_perdidas);
    comp('y salen de lo que queda por vender',
      d.cuerpo.unidades_quedan === 110 - 3 - 10, d.cuerpo.unidades_quedan);
    comp('pero no suben lo recuperado ni un peso', d.cuerpo.costo_recuperado === 900,
      d.cuerpo.costo_recuperado);

    console.log('\n=== La línea de tiempo y el ritmo ===');
    d = await pedir('/api/inversiones/' + idInversion);
    comp('hay meses en la línea', d.cuerpo.linea.length >= 1,
      JSON.stringify(d.cuerpo.linea.map(m => m.mes)));
    comp('van en orden', d.cuerpo.linea.every((m, i2, a) => !i2 || a[i2 - 1].mes <= m.mes));
    comp('el ritmo dice cuántos días lleva y cuánto falta',
      d.cuerpo.ritmo && d.cuerpo.ritmo.dias > 0 && d.cuerpo.ritmo.falta > 0,
      JSON.stringify(d.cuerpo.ritmo));

    console.log('\n=== Cancelar una inversión devuelve la mercancía ===');
    const i2 = await post('/api/inversiones', { nombre: 'Compra equivocada', moneda: 'CUP',
      fecha: dia(2), sitio_id: almacen,
      lineas: [{ producto_id: idCable, cantidad: 50, costo_unit: 500 }] });
    await post('/api/inversiones/' + i2.cuerpo.id + '/registrar', {});
    const conCable = await stock(almacen, idCable);
    const canc = await post('/api/inversiones/' + i2.cuerpo.id + '/cancelar', {});
    comp('se cancela', canc.status === 200 && canc.cuerpo.inversion.estado === 'cancelada',
      JSON.stringify(canc.cuerpo));
    comp('la mercancía sale otra vez del almacén',
      await stock(almacen, idCable) === conCable - 50);
    const f4 = (await pedir('/api/fondo')).cuerpo;
    comp('y el dinero vuelve al fondo', f4.resumen.CUP.inversion === 0,
      JSON.stringify(f4.resumen.CUP));

    console.log('\n=== No se vende lo que no está ===');
    const fantasma = await post('/api/productos', { nombre: 'Producto sin existencia', precio: 500 });
    const vFantasma = await post('/api/ventas', { sitio_id: almacen, moneda: 'CUP',
      lineas: [{ producto_id: fantasma.cuerpo.id, cantidad: 1 }] });
    comp('vender algo con cero existencia se rechaza', vFantasma.status === 400,
      JSON.stringify(vFantasma.cuerpo));
    comp('y dice qué hacer, no solo que no', /regístrala|registra/i.test(vFantasma.cuerpo.error || ''),
      vFantasma.cuerpo.error);
    // Dos líneas del mismo producto en la misma venta no pueden colar el doble
    const hayCable = await stock(almacen, idCable);
    const dosLineas = await post('/api/ventas', { sitio_id: almacen, moneda: 'CUP',
      lineas: [{ producto_id: idCable, cantidad: hayCable }, { producto_id: idCable, cantidad: 5 }] });
    comp('el mismo producto en dos líneas no burla la comprobación',
      dosLineas.status === 400, JSON.stringify(dosLineas.cuerpo).slice(0, 120));
    comp('y el stock no se movió', await stock(almacen, idCable) === hayCable);
    // Con el candado abierto, sí se puede: es decisión del dueño
    await post('/api/vender-sin-stock', { permitir: true });
    const forzada = await post('/api/ventas', { sitio_id: almacen, moneda: 'CUP',
      lineas: [{ producto_id: fantasma.cuerpo.id, cantidad: 1 }] });
    comp('con el ajuste abierto sí se vende, y el stock queda en negativo',
      forzada.status === 200 && await stock(almacen, fantasma.cuerpo.id) === -1,
      forzada.status + ' · stock ' + await stock(almacen, fantasma.cuerpo.id));
    await post('/api/vender-sin-stock', { permitir: false });

    console.log('\n=== La moneda del negocio ===');
    // Hasta aquí el negocio se ha medido en pesos. Se pasa a dólares: eso
    // convierte de una vez todos los costos guardados.
    const antesTasa = (await pedir('/api/tasa')).cuerpo;
    comp('de fábrica el negocio se mide en pesos', antesTasa.moneda_base === 'CUP',
      antesTasa.moneda_base);
    const sinTasa = await post('/api/moneda-base', { moneda: 'USD' });
    comp('sin decir a cuánto está el dólar, no se convierte nada', sinTasa.status === 400,
      JSON.stringify(sinTasa.cuerpo));

    // El cable costaba 400 CUP la unidad. A 400 el dólar, pasa a costar 1 USD.
    const cambio = await post('/api/moneda-base', { moneda: 'USD', tasa: 400 });
    comp('se convierte el negocio a dólares', cambio.status === 200 &&
      cambio.cuerpo.moneda_base === 'USD', JSON.stringify(cambio.cuerpo));
    const prods = (await pedir('/api/productos')).cuerpo.productos;
    const elCable = prods.find(p => p.nombre.startsWith('Cable'));
    comp('el costo del cable pasa de 400 CUP a 1 USD', elCable.costo === 1, elCable.costo);

    console.log('\n=== Una venta en pesos, medida en dólares ===');
    // Se vende 1 cable a 800 CUP con el dólar a 400 → 2 USD de ingreso,
    // 1 USD de costo, 1 USD de ganancia.
    // Se mide por DIFERENCIA con lo que ya había ese día: así la prueba no se
    // rompe cada vez que se añade una venta más arriba.
    const hoy = new Date().toISOString().slice(0, 10);
    const delDia = async () => (await pedir('/api/dia?sitio_id=' + almacen + '&fecha=' + hoy)).cuerpo.ventas;
    const antesV = await delDia();
    const vBase = await post('/api/ventas', { sitio_id: almacen, moneda: 'CUP',
      lineas: [{ producto_id: idCable, cantidad: 1 }] });
    comp('la venta se cobra en pesos', vBase.cuerpo.total === 800, JSON.stringify(vBase.cuerpo));
    let dd = await delDia();
    comp('el efectivo sube 800 pesos, que es lo que entró en la gaveta',
      dd.por_moneda.CUP - antesV.por_moneda.CUP === 800,
      JSON.stringify({ antes: antesV.por_moneda.CUP, ahora: dd.por_moneda.CUP }));
    comp('pero el negocio la mide en dólares: 2 USD vendidos',
      Math.round((dd.total - antesV.total) * 100) / 100 === 2, dd.total - antesV.total);
    comp('con 1 de costo y 1 de ganancia',
      dd.costo - antesV.costo === 1 && Math.round((dd.ganancia - antesV.ganancia) * 100) / 100 === 1,
      JSON.stringify({ c: dd.costo - antesV.costo, g: dd.ganancia - antesV.ganancia }));

    // Y lo que de verdad importa: subir el dólar NO puede cambiar lo de ayer.
    const congelado = dd.total, gananciaCongelada = dd.ganancia;
    await post('/api/tasa', { tasa: 500 });
    dd = await delDia();
    comp('subir el dólar NO cambia lo ya vendido ni su ganancia',
      dd.total === congelado && dd.ganancia === gananciaCongelada,
      JSON.stringify({ antes: congelado, ahora: dd.total }));
    // La siguiente venta sí usa el cambio nuevo: 800 CUP a 500 son 1,6 USD.
    await post('/api/ventas', { sitio_id: almacen, moneda: 'CUP',
      lineas: [{ producto_id: idCable, cantidad: 1 }] });
    dd = await delDia();
    comp('y la venta nueva sí va al cambio de hoy: sube 1,6',
      Math.round((dd.total - congelado) * 100) / 100 === 1.6, dd.total - congelado);
    await post('/api/tasa', { tasa: 400 });

    console.log('\n=== Las salvas ===');
    const s1 = await post('/api/salvas', {});
    comp('se puede salvar a mano', s1.status === 200 && /^dp-\d{8}-\d{4}\.db$/.test(s1.cuerpo.archivo),
      JSON.stringify(s1.cuerpo));
    const lista = await pedir('/api/salvas');
    comp('la salva aparece en la lista y pesa algo',
      lista.cuerpo.salvas.length >= 1 && lista.cuerpo.salvas[0].bytes > 1000,
      JSON.stringify(lista.cuerpo.salvas));
    // Una salva es la base entera: tiene que abrirse y tener los datos dentro.
    const copia = new (require('better-sqlite3'))(
      path.join(patio, 'salvas', s1.cuerpo.archivo), { readonly: true });
    const cuantas = copia.prepare('SELECT COUNT(*) n FROM inversiones').get().n;
    copia.close();
    comp('la copia se abre y trae las inversiones dentro', cuantas >= 2, cuantas);
    // Pedir un archivo de otra carpeta escribiendo «../» no puede colar
    const fuera = await pedir('/api/salvas/..%2F..%2Fserver.js');
    comp('no se puede sacar cualquier archivo por la dirección',
      fuera.status === 400 || fuera.status === 404, fuera.status);

    console.log('\n=== El dinero puede salir de la gaveta de un punto ===');
    // Lo único que sabía hacer el botón «Inversión» del fondo, que se quitó por
    // hacer solo la mitad. Si se coge de la gaveta de un punto hay que decirlo,
    // o esa gaveta deja de cuadrar con lo que hay dentro de verdad.
    //
    // Se mide la DIFERENCIA y no el total: así la comprobación sigue valiendo
    // aunque más arriba se le añada alguna compra más a este mismo punto.
    const invAntes = ((await pedir('/api/negocio')).cuerpo.sitios
      .find(p => p.sitio_id === punto.cuerpo.id) || {}).fondo.USD.inversion;
    const invPunto = await post('/api/inversiones', { nombre: 'Comida de la obra',
      moneda: 'USD', sitio_id: punto.cuerpo.id,
      lineas: [{ descripcion: 'Almuerzo del equipo', cantidad: 1, costo_unit: 25 }] });
    await post('/api/inversiones/' + invPunto.cuerpo.id + '/registrar', {});
    const gav = (await pedir('/api/negocio')).cuerpo.sitios
      .find(p => p.sitio_id === punto.cuerpo.id);
    comp('sale de la gaveta de ese punto y no del montón',
      gav.fondo.USD.inversion === invAntes + 25, JSON.stringify(gav.fondo.USD));
    await post('/api/inversiones/' + invPunto.cuerpo.id + '/cancelar', {});
    const gav2 = (await pedir('/api/negocio')).cuerpo.sitios
      .find(p => p.sitio_id === punto.cuerpo.id);
    comp('y al cancelarla vuelve a la MISMA gaveta',
      gav2.fondo.USD.inversion === invAntes, JSON.stringify(gav2.fondo.USD));

    console.log('\n=== El servidor dice qué versión del front está sirviendo ===');
    // Con esto el aparato sabe si se quedó con código viejo. Si esta línea se
    // desincroniza del sw.js, el aviso de «hay versión nueva» saldría siempre o
    // no saldría nunca, que son las dos formas de que nadie le haga caso.
    const salud = (await pedir('/api/salud')).cuerpo;
    const cacheSw = (fs.readFileSync(path.join(raiz, 'public/sw.js'), 'utf8')
      .match(/const CACHE = 'dp-([^']+)'/) || [])[1];
    comp('la versión que dice el servidor es la del sw.js',
      !!cacheSw && salud.front === cacheSw, JSON.stringify({ salud: salud.front, sw: cacheSw }));

    console.log('\n=== TODO EL NEGOCIO: la suma de los sitios ES el total ===');
    // Lo que hace útil esta pantalla es justo esto: que las filas sumen el
    // total. Si algún día dejaran de sumar, el dueño estaría mirando un número
    // que no significa nada y no habría forma de saberlo.
    const neg = () => pedir('/api/negocio').then(r => r.cuerpo);
    let n = await neg();
    const suma = (d, f) => d.sitios.reduce((s, p) => s + f(p), 0);
    const casi = (a, b) => Math.abs(a - b) < 0.05;
    comp('lo vendido: las filas suman el total',
      casi(suma(n, p => p.vendido), n.total.vendido),
      JSON.stringify({ filas: suma(n, p => p.vendido), total: n.total.vendido }));
    comp('las mermas también', casi(suma(n, p => p.mermas.valor), n.total.mermas.valor));
    comp('y las entradas de mercancía', casi(suma(n, p => p.entradas.valor), n.total.entradas.valor));
    comp('y el valor del inventario', casi(suma(n, p => p.inventario.valor), n.total.inventario.valor));
    comp('y la gaveta, cada moneda por su lado',
      casi(suma(n, p => p.gaveta.CUP), n.total.gaveta.CUP) &&
      casi(suma(n, p => p.gaveta.USD), n.total.gaveta.USD),
      JSON.stringify(n.total.gaveta));

    // Las gavetas de todos los sitios son el saldo del fondo: es el mismo
    // dinero contado de dos maneras, y tiene que dar lo mismo.
    const fSaldo = (await pedir('/api/fondo')).cuerpo.saldo;
    comp('las gavetas juntas son el saldo del fondo (CUP)',
      casi(n.total.gaveta.CUP, fSaldo.CUP), JSON.stringify({ g: n.total.gaveta.CUP, f: fSaldo.CUP }));
    comp('y en USD', casi(n.total.gaveta.USD, fSaldo.USD),
      JSON.stringify({ g: n.total.gaveta.USD, f: fSaldo.USD }));

    // Y el inventario de cada sitio es el mismo que enseña la pantalla del
    // almacén, que se saca por otro camino (/api/stock).
    const stAlm = (await pedir('/api/stock?sitio_id=' + almacen)).cuerpo.stock || {};
    const udsAlm = Object.values(stAlm).reduce((s, x) => s + (x > 0 ? x : 0), 0);
    const filaAlm = n.sitios.find(p => p.sitio_id === almacen);
    comp('las unidades del almacén cuadran con /api/stock',
      casi(filaAlm.inventario.unidades, udsAlm),
      JSON.stringify({ negocio: filaAlm.inventario.unidades, stock: udsAlm }));

    console.log('\n=== «Lo más vendido» se mide en la moneda del negocio ===');
    // El precio de cada movimiento va en la moneda de SU venta y el costo va en
    // la del negocio: restarlos en SQL daba una ganancia enorme e imposible.
    const rs = (await pedir('/api/resumen')).cuerpo;
    const sumaTop = rs.top_productos.reduce((s, p) => s + p.total, 0);
    comp('lo más vendido suma lo mismo que el total de ventas',
      casi(sumaTop, rs.ventas.total),
      JSON.stringify({ top: sumaTop, ventas: rs.ventas.total }));
    comp('y ninguna ganancia es mayor que lo vendido de ese producto',
      rs.top_productos.every(p => p.ganancia <= p.total + 0.05),
      JSON.stringify(rs.top_productos.map(p => [p.codigo, p.total, p.ganancia])));

    console.log('\n=== Lo que no es de ningún punto tiene su propia fila ===');
    const delNegocio = n.sitios.find(p => p.sitio_id === null);
    comp('existe la fila «Del negocio»', !!delNegocio, JSON.stringify(n.sitios.map(p => p.sitio)));
    comp('ahí está el aporte del socio, que no entró por ninguna tienda',
      !!delNegocio && delNegocio.fondo.CUP.ingreso === 1000,
      JSON.stringify(delNegocio && delNegocio.fondo));
    // Y desde el 21 de agosto de 2026 NO hay inversiones en esa fila: todas salen
    // de una caja de verdad (#38), así que la gaveta de cada punto dice lo que
    // tiene dentro. La fila se queda para lo que sigue sin sitio y para lo viejo.
    comp('y ninguna inversión, que ya todas salen de una caja de verdad',
      !!delNegocio && delNegocio.fondo.CUP.inversion === 0 &&
      delNegocio.fondo.USD.inversion === 0,
      JSON.stringify(delNegocio && delNegocio.fondo));
    comp('esa fila no tiene ventas ni mercancía',
      !!delNegocio && delNegocio.ventas === 0 && delNegocio.inventario.unidades === 0);

    console.log('\n=== Un apunte anulado deja de contar ===');
    // Con «anula_a IS NULL» a secas, la compra anulada seguía sumando: la marca
    // la lleva el movimiento CONTRARIO, no el anulado. Se comprueba entrando
    // mercancía con una inversión y cancelándola después.
    const entradasAntes = n.total.entradas.unidades;
    const iAnu = await post('/api/inversiones', { nombre: 'Compra que se cae', moneda: 'CUP',
      sitio_id: almacen,
      lineas: [{ producto_id: idCable, cantidad: 25, costo_unit: 10,
                 reparto: [{ sitio_id: almacen, cantidad: 25 }] }] });
    await post('/api/inversiones/' + iAnu.cuerpo.id + '/registrar', {});
    n = await neg();
    comp('al registrarla, entran 25 unidades más',
      casi(n.total.entradas.unidades - entradasAntes, 25),
      n.total.entradas.unidades - entradasAntes);
    await post('/api/inversiones/' + iAnu.cuerpo.id + '/cancelar', {});
    n = await neg();
    comp('al cancelarla, las entradas vuelven a lo que había',
      casi(n.total.entradas.unidades, entradasAntes),
      JSON.stringify({ antes: entradasAntes, ahora: n.total.entradas.unidades }));

    console.log('\n=== Ni se compra sin decir de qué caja, ni con dinero que no está ===');
    // Decisión #38, 21 de agosto de 2026. Se quitó la opción «Del fondo del negocio»:
    // el dinero sale de una gaveta de verdad —la tienda, el almacén, la brigada— y
    // solo si está dentro.
    const sinCaja = await post('/api/inversiones', { nombre: 'Compra sin caja', moneda: 'CUP',
      lineas: [{ producto_id: idCable, cantidad: 1, costo_unit: 10 }] });
    comp('una inversión que no dice de qué caja sale se rechaza', sinCaja.status === 400,
      JSON.stringify(sinCaja.cuerpo));
    comp('y lo dice nombrando los sitios, no con un código',
      /la tienda, el almacén o la brigada/.test(sinCaja.cuerpo.error || ''), sinCaja.cuerpo.error);

    const brigada = (await post('/api/sitios',
      { nombre: 'Brigada', tipo: 'punto', padre_id: almacen })).cuerpo.id;
    const cara = await post('/api/inversiones', { nombre: 'Compra sin dinero', moneda: 'CUP',
      sitio_id: brigada,
      lineas: [{ producto_id: idCable, cantidad: 10, costo_unit: 1000,
                 reparto: [{ sitio_id: brigada, cantidad: 10 }] }] });
    // El borrador SÍ se guarda: preparar la compra no saca un peso, y el dinero
    // puede estar de camino. Lo que no puede es registrarse, que es cuando sale.
    comp('el borrador se guarda aunque la caja esté vacía', cara.status === 200,
      JSON.stringify(cara.cuerpo));
    const sinPlata = await post('/api/inversiones/' + cara.cuerpo.id + '/registrar', {});
    comp('pero registrarla sin ese dinero en esa caja se rechaza', sinPlata.status === 400,
      JSON.stringify(sinPlata.cuerpo));
    comp('y el cartel dice cuánto hay y cuánto se está sacando',
      /hay 0 CUP y estás sacando 10000 CUP/.test(sinPlata.cuerpo.error || ''),
      sinPlata.cuerpo.error);
    comp('no entró ni una unidad en el inventario', await stock(brigada, idCable) === 0,
      await stock(brigada, idCable));
    comp('y sigue en borrador, esperando a que haya el dinero',
      (await pedir('/api/inversiones/' + cara.cuerpo.id)).cuerpo.inversion.estado === 'borrador');

    // Y con el dinero apuntado, la misma compra entra sin tocar nada más: el
    // freno no obliga a rehacer la inversión, solo a que el dinero exista.
    await meter(brigada, 'CUP', 10000);
    const ahoraSi = await post('/api/inversiones/' + cara.cuerpo.id + '/registrar', {});
    comp('apuntando el dinero que entró, la misma compra pasa', ahoraSi.status === 200,
      JSON.stringify(ahoraSi.cuerpo.error));
    comp('las 10 unidades entran en la brigada', await stock(brigada, idCable) === 10,
      await stock(brigada, idCable));
    const gavBrig = ((await pedir('/api/fondo')).cuerpo.gavetas || [])
      .find(x => x.sitio_id === brigada);
    comp('y su caja queda en cero: entró 10 000 y salieron 10 000',
      !!gavBrig && casi(gavBrig.CUP, 0), JSON.stringify(gavBrig));

    console.log('\n=== Sin permiso para ver dinero, ni una cifra ===');
    // Desde el catálogo nuevo de permisos (DECISIONES.md #35), ver las inversiones
    // es un permiso propio: al vendedor de mostrador ya no se le enseña esa lista.
    const soloVende = await post('/api/cargos', { nombre: 'Solo mostrador',
      permisos: ['vender'] });
    await post('/api/personas', { nombre: 'Luis', usuario: 'luism', pin: '9876',
      cargo_id: soloVende.cuerpo.id });
    const guardado = cab;
    const sesLuis = await post('/api/auth/entrar', { usuario: 'luism', pin: '9876' });
    cab = { Authorization: 'Bearer ' + sesLuis.cuerpo.token };
    const negada = await pedir('/api/inversiones');
    comp('a quien solo vende, la lista de inversiones se le niega entera',
      negada.status === 403, negada.status);
    comp('y se le dice QUÉ permiso le falta, para poder dárselo si se quiere',
      (negada.cuerpo.falta || []).some(f => f.id === 'ver_inversiones'),
      JSON.stringify(negada.cuerpo));

    // Y el caso que sigue importando: quien SÍ puede ver las inversiones pero no
    // los costos y las ganancias. Ve la lista, sin una sola cifra de dinero.
    cab = guardado;
    const cargo = await post('/api/cargos', { nombre: 'Encargado',
      permisos: ['vender', 'ver_inversiones', 'ver_negocio_entero'] });
    await post('/api/personas', { nombre: 'Ana', usuario: 'ana', pin: '4321',
      cargo_id: cargo.cuerpo.id });
    const sesAna = await post('/api/auth/entrar', { usuario: 'ana', pin: '4321' });
    cab = { Authorization: 'Bearer ' + sesAna.cuerpo.token };
    const vista = await pedir('/api/inversiones');
    comp('ve la lista pero sin cifras',
      vista.cuerpo.cifras === false && vista.cuerpo.inversiones[0].importe === undefined,
      JSON.stringify(vista.cuerpo.inversiones[0]));
    // Puede abrir la ficha —tiene permiso para ver inversiones— pero sin una sola
    // cifra: ver qué compras hay en marcha y ver a qué precio se compró son dos
    // permisos distintos desde el catálogo nuevo (#35).
    const detalle = await pedir('/api/inversiones/' + idInversion);
    comp('abre la ficha, porque puede ver inversiones', detalle.status === 200,
      detalle.status);
    comp('pero la ficha le llega SIN cifras',
      detalle.cuerpo.cifras === false && detalle.cuerpo.inversion.importe === undefined &&
      (detalle.cuerpo.lineas || []).length === 0,
      JSON.stringify(detalle.cuerpo).slice(0, 200));
    // Lo mismo en el cuadro del negocio: un dato que llega al aparato ya es
    // público, así que los costos y el dinero no salen del servidor (#10).
    const negAna = (await pedir('/api/negocio')).cuerpo;
    comp('en el cuadro del negocio no le llegan los costos',
      negAna.total.costo === null && negAna.total.ganancia === null,
      JSON.stringify({ c: negAna.total.costo, g: negAna.total.ganancia }));
    comp('ni el dinero de las gavetas',
      negAna.total.gaveta === null && negAna.sitios.every(p => p.gaveta === null),
      JSON.stringify(negAna.total.gaveta));
    comp('y sin dinero tampoco sale la fila del negocio, que solo es dinero',
      negAna.sitios.every(p => p.sitio_id !== null),
      JSON.stringify(negAna.sitios.map(p => p.sitio)));
    cab = guardado;

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

// Un apunte de ANTES del 31 de agosto de 2026, cuando un ingreso a mano todavía
// podía no llevar sitio. Desde ese día la puerta lo rechaza —se quitó «Ninguno en
// concreto»— pero los que YA estaban escritos siguen ahí y siguen sumando en la
// fila «De la empresa»: el pasado no se reescribe (#2).
//
// Se escribe directo en la base a propósito, porque es exactamente lo que es: un
// registro heredado, no algo que la aplicación pueda crear hoy. Sembrarlo por la
// puerta sería pedirle que acepte lo que acaba de prohibir.
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
