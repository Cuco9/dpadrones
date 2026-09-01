// La tecla «atrás» del teléfono.
//
// Sin nada que lo frene, UN solo toque en «atrás» cierra la aplicación
// instalada: no hay página anterior, así que el sistema la saca. Y pasa a mitad
// de una venta, con el carro a medias. El dueño lo pidió el 1 de septiembre de
// 2026: «que tenga que dar dos veces atrás para que me saque».
//
// Esto NO es una prueba de las que leen el archivo y buscan un texto. Aquí se
// EJECUTA el código de verdad —el trozo se recorta de public/app.js, no se
// copia— contra un navegador de mentira, y se mira qué hace:
//
//   · con una ventana abierta, «atrás» la cierra y nadie sale;
//   · y la cierra LLAMANDO A SU FUNCIÓN, que es lo que apaga la cámara del
//     escáner; quitarle la clase la escondería con la cámara encendida;
//   · sin ventanas, el primer toque avisa y NO deja salir;
//   · el segundo, dentro de dos segundos, sí sale;
//   · pasados los dos segundos vuelve a hacer falta avisar: el que se distrajo
//     y vuelve diez minutos después no puede salirse de un toque.
//
//   node pruebas/atras.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const raiz = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(raiz, 'public/app.js'), 'utf8');

let ok = 0, mal = 0;
const comp = (nombre, cierto, extra) => {
  if (cierto) { ok++; console.log('  ok   ' + nombre); }
  else { mal++; console.log('  MAL  ' + nombre + (extra !== undefined ? '  → ' + extra : '')); }
};

// ─── Recortar el trozo de verdad ──────────────────────────────
// Se recorta por sus dos extremos. Si alguien lo mueve o le cambia el nombre a
// la marca, esto se para en vez de probar un trozo que ya no es el que corre.
const desde = js.indexOf('// ─── La tecla «atrás» del teléfono');
const hasta = js.indexOf('// ─── Lo que se carga al arrancar', desde);
if (desde < 0 || hasta < 0 || hasta <= desde) {
  console.log('  MAL  no se encuentra el trozo de la tecla «atrás» en public/app.js');
  console.log('\nFALLAN 1 de 1');
  process.exit(1);
}
const trozo = js.slice(desde, hasta);

// ─── Un navegador de mentira ──────────────────────────────────
function montar() {
  const registro = { empujones: 0, atras: 0, avisos: [], cerradas: [] };
  const abiertas = [];          // ventanas «abiertas», en orden del HTML

  const velo = (id, nombreCerrar) => ({
    id,
    getAttribute: a => a === 'onclick' ? 'if(event.target===this)' + nombreCerrar + '()' : null,
    classList: { remove: c => registro.cerradas.push(id + ':clase-' + c) }
  });

  // Un reloj que se puede adelantar a mano. Hace falta uno: la cuenta de los
  // dos segundos se guarda en una variable del propio trozo, que desde fuera no
  // se ve ni se toca. Adelantando el reloj se prueba lo que de verdad importa
  // —que pasado el rato vuelva a hacer falta avisar— sin esperar de verdad.
  let reloj = 1e12;
  let alPop = null;
  const win = {
    history: {
      pushState: () => { registro.empujones++; },
      back: () => { registro.atras++; }
    },
    addEventListener: (que, fn) => { if (que === 'popstate') alPop = fn; },
    setTimeout: fn => fn(),        // el aplazamiento no cambia lo que se prueba
    Date: { now: () => reloj },
    // Las funciones que cierran cada ventana, tal y como viven en el navegador:
    // colgadas de window y llamadas por su nombre.
    cerrarFicha: () => registro.cerradas.push('ficha:funcion'),
    cerrarEscaner: () => registro.cerradas.push('escaner:funcion'),
    toast: msg => registro.avisos.push(msg)
  };
  win.window = win;
  win.document = {
    querySelectorAll: sel => sel === '.velo.abierto' ? abiertas : []
  };

  vm.createContext(win);
  vm.runInContext(trozo, win);

  return {
    registro,
    abrir: (...vs) => { abiertas.length = 0; vs.forEach(v => abiertas.push(v)); },
    velo,
    pulsarAtras: () => alPop({}),
    hayHandler: () => typeof alPop === 'function',
    envejecer: ms => { reloj += ms; }
  };
}

console.log('\n=== La red se pone sola al arrancar ===');
{
  const n = montar();
  comp('hay alguien escuchando el «atrás»', n.hayHandler());
  comp('y se deja una entrada de historia de sobra puesta',
    n.registro.empujones === 1, n.registro.empujones);
}

console.log('\n=== Con una ventana abierta, «atrás» la cierra y nadie sale ===');
{
  const n = montar();
  n.abrir(n.velo('velo-ficha', 'cerrarFicha'));
  n.pulsarAtras();
  comp('se cierra llamando a SU función, no quitando la clase',
    n.registro.cerradas.length === 1 && n.registro.cerradas[0] === 'ficha:funcion',
    JSON.stringify(n.registro.cerradas));
  comp('no se avisa de salir: no se estaba saliendo',
    n.registro.avisos.length === 0, JSON.stringify(n.registro.avisos));
  comp('no se sale de la aplicación', n.registro.atras === 0);
  comp('y la red se vuelve a poner', n.registro.empujones === 2, n.registro.empujones);
}

console.log('\n=== La cámara del escáner se apaga, que es de lo que se trata ===');
// Si la ventana se cerrara quitándole la clase, la cámara del teléfono se
// quedaría encendida detrás, comiéndose la batería y con la luz dada.
{
  const n = montar();
  n.abrir(n.velo('velo-escaner', 'cerrarEscaner'));
  n.pulsarAtras();
  comp('se llama a cerrarEscaner(), que apaga la cámara',
    n.registro.cerradas.length === 1 && n.registro.cerradas[0] === 'escaner:funcion',
    JSON.stringify(n.registro.cerradas));
}

console.log('\n=== Con dos ventanas, se cierra la de encima ===');
// Todos los velos comparten z-index, así que la que se ve encima es la ÚLTIMA
// del HTML. Pasa de verdad: «crear producto» se abre sobre la de una entrada.
{
  const n = montar();
  n.abrir(n.velo('velo-mov', 'cerrarFicha'), n.velo('velo-nuevoprod', 'cerrarEscaner'));
  n.pulsarAtras();
  comp('la última del HTML es la que se cierra',
    n.registro.cerradas.length === 1 && n.registro.cerradas[0] === 'escaner:funcion',
    JSON.stringify(n.registro.cerradas));
}

console.log('\n=== Sin ventanas: hacen falta DOS toques ===');
{
  const n = montar();
  n.pulsarAtras();
  comp('el primer toque avisa', n.registro.avisos.length === 1, JSON.stringify(n.registro.avisos));
  comp('y el aviso dice qué hacer, no solo que pasa algo',
    /atrás/i.test(n.registro.avisos[0] || '') && /salir/i.test(n.registro.avisos[0] || ''),
    n.registro.avisos[0]);
  comp('el primer toque NO saca de la aplicación', n.registro.atras === 0);
  comp('y deja la red puesta otra vez', n.registro.empujones === 2, n.registro.empujones);

  n.pulsarAtras();
  comp('el segundo toque sí sale', n.registro.atras === 1, n.registro.atras);
  comp('y ya no vuelve a poner la red: si la pusiera, no saldría nunca',
    n.registro.empujones === 2, n.registro.empujones);
}

console.log('\n=== Pasados los dos segundos, se olvida ===');
// Quien se distrajo y vuelve al rato no puede salirse de un solo toque.
{
  const n = montar();
  n.pulsarAtras();
  n.envejecer(5000);
  n.pulsarAtras();
  comp('el toque de después vuelve a avisar', n.registro.avisos.length === 2,
    JSON.stringify(n.registro.avisos));
  comp('y sigue sin sacar a nadie', n.registro.atras === 0, n.registro.atras);
}

console.log('\n' + (mal ? 'FALLAN ' + mal + ' de ' + (ok + mal) : 'TODO BIEN: ' + ok + ' comprobaciones'));
process.exit(mal ? 1 : 0);
