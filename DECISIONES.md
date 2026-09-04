# Decisiones de D´Padrones

Este archivo existe para que dentro de tres meses nadie —ni yo— rompa algo sin
saber por qué estaba hecho así. Cada decisión lleva el motivo.

Casi todas nacen de los fallos reales de **una aplicación anterior** el 10 de agosto de
2026: un día entero persiguiendo inventarios que desaparecían, ventas infladas y
arreglos que nunca llegaban a los teléfonos.

## Qué hace y qué no hace

D´Padrones lleva **venta y almacén**, y nada más. Por dentro: el stock
calculado, los apuntes inmutables, el candado, la sincronización y las dos
monedas. Lo que se dejó fuera, porque este negocio **solo vende mercancía**, es
todo lo que servía para hacer trabajos de montaje:

- los **servicios y los trabajos** (las plantillas y las cotizaciones),
- los **clientes** y el **certificado de garantía**, que colgaban de ellos,
- el **sitio web** entero —la tienda, el blog, los pedidos y las opiniones—,
- la pantalla de **Productos**, que se juntó con la de **Almacén**: el
  catálogo se ve y se edita desde donde se mira la mercancía.

**Los números de las decisiones no se han recolocado.** Faltan la 14 a la 17,
la 19, la 23, la 26 y la 34 porque hablaban de eso, y renumerar el resto
dejaría mintiendo a los cientos de comentarios del código que las citan por su
número. Un hueco es más barato de entender que una referencia falsa.

---

## 1. El stock NO se guarda. Se calcula.

**La regla:** en ninguna parte hay un campo «este punto tiene 47 unidades». Hay
una lista de **movimientos** (entrada, venta, merma, traslado, ajuste, conteo) y
el stock es la suma de esa lista.

**Por qué:** Una aplicación anterior guardaba el inventario como una foto (`invInicial`).
Cuando dos aparatos guardaban esa foto, uno pisaba al otro y la mercancía
desaparecía. Con varios aparatos por punto y sin internet, guardar el número es
imposible de hacer bien.

**Consecuencia:** juntar dos aparatos es **unir listas**. No hay que decidir
quién gana. Da igual el orden y da igual cuántas veces se junte: el resultado es
el mismo.

**Y una trampa de esta regla, vista el 1 de septiembre de 2026:** por fuera se
notaba como un olvido. Se creaba un producto en el Almacén y no había ninguna
casilla para decir cuántos hay, porque la existencia solo entraba por el botón
«Entrada». La regla estaba bien; lo que faltaba era la pregunta. La ficha de un
producto **nuevo** pregunta ahora «¿Cuánto tienes ahora?» y la aplicación apunta
por dentro la **entrada** correspondiente al sitio donde se está, que es
exactamente lo que habría hecho el botón. **La casilla no guarda nada**: no viaja
dentro del producto ni existe ninguna columna nueva.

En un producto que **ya existe** la casilla no sale, y no es por pereza: escribir
ahí la existencia sería pisar el historial en vez de apuntar lo que pasó (#2).
Para eso están Entrada, Merma y el conteo del cierre.

El producto se crea primero y la entrada después, porque hasta que no existe no
hay a qué apuntarla. Si la entrada falla —la jornada de ese sitio ya cerrada, o
el internet— **se dice en pantalla**, con el producto ya creado: callarlo dejaría
el inventario diciendo cero con la mercancía en el estante.

## 2. Los movimientos son inmutables. Nada se borra ni se edita.

Cada movimiento nace con un identificador único y ya no cambia nunca.
¿Anular una venta? Se mete el movimiento contrario, apuntando al original.

**Por qué:** si un movimiento se puede editar, vuelve el problema de quién
tiene la razón. Además así el historial cuenta lo que pasó de verdad,
incluidos los errores y sus correcciones.

## 3. Cada dato tiene un dueño, y solo uno.

| Dato | Dueño | Viaja |
|---|---|---|
| Ventas, mermas, gastos, cierres de un punto | ese punto | punto → principal |
| Catálogo: productos, códigos, precios, comisiones | el administrador | principal → puntos |
| Traslado: la salida del almacén | el almacén | almacén → punto |
| Traslado: la recepción | el punto que recibe | punto → almacén |

**Por qué:** sin internet no hay árbitro. Si dos sitios pueden cambiar lo mismo,
tarde o temprano se contradicen. Con un solo dueño por dato eso es imposible.

**El traslado tiene dos mitades** justamente por esto: el almacén dice «salieron
20», el punto dice «recibí 18». Nadie corrige al otro; la diferencia queda a la
vista como faltante en tránsito.

## 4. Vender descuenta en el momento.

Al escanear un producto se registra la venta y sale del stock. El conteo del día
sirve para **detectar descuadres**, no para calcular las ventas.

**Por qué:** en una aplicación anterior las ventas se deducían del conteo al cerrar
(`vendido = disponible − contado`). Eso hacía que apuntar mercancía después de
cerrar el día **inventara ventas que no existieron**, con su ganancia y el
salario del trabajador calculados sobre ellas.

## 5. Un día cerrado no se toca.

Si se intenta apuntar algo en un día ya cerrado, va al primer día abierto y se
avisa. Nunca se modifica lo cerrado.

**Por qué:** exactamente el fallo anterior. Y porque un cierre es un documento
contable: si cambia después de firmado, no sirve para nada.

## 6. No se vende lo que no está. Y si aun así pasa, se ve.

**La caja no deja cobrar un producto sin existencia.** Lo decidió el dueño el
12 de agosto, mirando su tienda física: allí no se puede vender lo que no está
en el estante, y una caja que lo permite acaba con un inventario que no sirve.
Lo comprueba el **servidor**, no la pantalla (decisión #10), y avisa al añadir
al carro, no al final con el cliente delante.

**El aviso dice qué hacer:** si la mercancía llegó y nadie la apuntó, lo que hay
que hacer es **registrar la entrada en el Almacén**, no forzar la venta. Es lo
que había que hacer de todas formas, y así el inventario deja de mentir.

**Se puede abrir** (Ajustes → «Vender sin existencia»), porque hay negocios
donde frenar la caja cuesta más que un descuadre. Viene cerrado.

**Y aun cerrado, el stock puede quedar en negativo**, así que la app lo sigue
enseñando: dos cajas sin internet pueden vender a la vez la última unidad, cada
una con su comprobación en verde, y eso solo se ve al juntarlas. Es un hecho
físico, no un fallo de datos. El Almacén tiene el filtro «En negativo» para
encontrarlo.

## 7. El número de versión del service worker sube en CADA cambio del front.

En `public/sw.js`, la constante `CACHE`. Y la app enseña su versión al pie de
Ajustes.

**Por qué:** en una aplicación anterior `sw.js` estuvo dos meses sin tocarse. El navegador
solo avisa de que hay versión nueva cuando ese archivo cambia, así que **seis
arreglos seguidos nunca llegaron a los teléfonos** mientras dábamos el trabajo
por terminado. Se perdió medio día persiguiendo un fallo ya arreglado.

**Y subir el número no basta: hay que poder forzarla desde la aplicación.** El
navegador se trae el service worker nuevo cuando le parece y mientras tanto
sigue sirviendo el código guardado. Recargar con `Ctrl+Shift+R` **no vale**: eso
salta la caché del navegador, que es otra distinta de la del service worker. En
una PC se arregla abriendo la consola; **en un teléfono no hay consola**, y la
única salida era cerrar y abrir la aplicación varias veces a ver si sonaba la
flauta. Pasó el 13 de agosto de 2026 con el dueño delante, y por eso ahora:

- el servidor dice en `/api/salud` **qué versión del front está sirviendo**,
  sacada del propio `sw.js`;
- la aplicación la compara con la suya al arrancar y cada media hora, y si no
  coinciden **avisa en la caja**, que es donde está la gente;
- en Ajustes hay **«Buscar actualización»**, que compara y, si hace falta, tira
  el service worker y sus cajas y recarga. Es de bruto y es lo único que
  funciona siempre. No se pierde ningún dato: ahí solo hay archivos del
  programa, nunca ventas ni inventario.

**No se actualiza sola.** Recargar en mitad de un cobro, con el cliente delante,
sería peor que esperar cinco minutos. El aviso se ve y decide la persona.

## 8. Nada se carga de internet. Todo va dentro de la app.

El lector de códigos por cámara, los tipos de letra, los iconos: todo local.

**Por qué:** la app tiene que funcionar sin conexión. Una sola dependencia
externa la deja inservible en el peor momento.

## 9. Todo lo que se importa, se sube.

Si entra un catálogo por archivo, la app lo manda al servidor en cuanto pueda.

**Por qué:** en una aplicación anterior importar un backup escribía solo en el teléfono.
Resultado medido: **49 de 55 productos** de un punto existían únicamente en un
aparato. Si se pierde ese teléfono, se pierde el catálogo.

## 10. Los permisos los comprueba el SERVIDOR. Esconder un botón es decoración.

Cada endpoint que cambia algo pide su permiso. La aplicación además esconde lo
que ese cargo no puede hacer, pero eso es **comodidad, no seguridad**: cualquiera
con el navegador abierto puede llamar al servidor directamente.

Lo mismo con los números: quien no tenga `ver_ganancias` **no recibe los costos**.
No se ocultan en la pantalla — no salen del servidor. Un dato que viaja al
aparato ya es público.

El cargo de Administrador no se puede editar. Si alguien le quitara permisos por
error, nadie podría volver a entrar a arreglarlo.

## 11. La marca de sincronización tiene que mirar TODAS las columnas que cambian.

Al mandar solo lo nuevo desde la última vez, la trampa está en los cambios que
**no tocan la fecha de creación**: anular una venta rellena `anulada_en`, y
recibir un traslado rellena `recibido_en`, pero ninguno de los dos cambia
`creado_en`. Si la marca mirara solo esa columna, esos cambios se quedarían
fuera del paquete para siempre y el otro lado nunca se enteraría.

Pasó de verdad en la prueba de la fase 8: los movimientos de la anulación
viajaban, pero la venta seguía apareciendo como buena en la otra copia. Por eso
`ventas` y `traslados` llevan **dos columnas de marca**.

**Al añadir una tabla o una columna que se rellene después, hay que revisar
esto.** Es el fallo más fácil de no ver, porque todo parece funcionar.

## 12. Git desde el primer commit, y salva antes de cada despliegue.

**Por qué:** Una aplicación anterior pasó semanas sin control de versiones y con código en
el servidor que no estaba en ningún repositorio. Recuperarlo costó una sesión
entera.

## 13. El candado no es opcional, y por eso hay un sello del negocio.

La aplicación va por **HTTPS**, con un certificado que se fabrica sola en la
propia máquina. En los locales no hay internet, así que no se puede pedir uno
de los normales: se crea una **autoridad propia** («el sello del negocio»,
`certs/sello-del-negocio.crt`) que se instala **una vez** en cada aparato.

**Por qué HTTPS, más allá de lo evidente:** sí, el PIN viajaba en claro por el
WiFi del local y eso ya bastaba. Pero hay dos cosas que el navegador **prohíbe**
fuera de una página segura, por muy bien que esté el código:

- la **cámara**, o sea el escáner de códigos;
- el **service worker**, o sea trabajar sin internet. Media aplicación.

**Por qué una autoridad y no un certificado suelto:** con un certificado que el
teléfono no reconoce, Chrome enseña el aviso rojo y **se niega a registrar el
service worker**. Se puede pulsar «continuar» y ver la aplicación, pero se queda
sin la parte de funcionar sin conexión — que es justo para lo que se hizo así.

**Decisiones que hay dentro y conviene no deshacer:**

- **Un solo puerto (3010) para las dos cosas.** Se mira el primer byte de cada
  conexión: un saludo TLS empieza por `0x16`. Por `https://…:3010` va la
  aplicación; por `http://…:3010`, la página que explica cómo instalar el sello.
  Así quien escriba la dirección de siempre no ve un error incomprensible, y no
  hay que abrir un segundo puerto en el cortafuegos.
- **El sello no cambia nunca.** Si cambiara, habría que reinstalarlo en todos los
  aparatos. El certificado del servidor sí se vuelve a emitir solo cuando cambian
  las direcciones de la máquina (el router reparte otra) o cuando va a caducar.
- **Dentro de un certificado, solo ASCII.** Un guion largo (—) en el nombre
  descuadra el cálculo de longitudes y sale un archivo con pinta de certificado
  que ningún navegador puede leer: *bad base64 decode*, y el servidor no arranca.
  Pasó en el primer intento. Ahora se comprueba antes de guardar nada.
- **La sincronización por red apunta el sello del otro y no acepta otro después**
  (como SSH). Sin esto, con el candado puesto ninguna copia se fiaría de las
  demás y la sincronización por red habría dejado de funcionar en silencio. Si
  una copia se reinstala desde cero, hay que **olvidar su sello a mano** en
  Ajustes: es un botón, no algo automático, para que sea decisión de alguien.
- Lo que se apunta es el **sello**, no el certificado del servidor: ese se
  reemite solo cada vez que cambia una dirección, y apuntarlo rompería la
  sincronización cada dos por tres.
- `DP_HTTP=1` arranca sin candado. Es una salida de emergencia y lo dice a
  gritos al arrancar. `DP_CERTS` cambia dónde viven los certificados.

**`certs/` no entra en git.** Dentro está la clave del sello: quien la tenga
puede hacerse pasar por el servidor del negocio.

## 18. La inversión es una lista de productos, y su recuperación se calcula.

Una **inversión** es una compra de mercancía con nombre: qué se compró, a qué
precio cada cosa y a qué almacén o punto va cada unidad. **El importe no se
escribe**: sale de sumar las líneas. Cada inversión es independiente y lleva su
propia cuenta de cuánto se ha recuperado.

**No guarda ni una cifra de recuperación.** Se calcula de las ventas de esos
mismos productos, igual que el stock se calcula de los movimientos (decisión
#1). Si guardara «recuperado: 2 830», ese número y el inventario podrían
contradecirse, y el día que se contradijeran no habría forma de saber cuál
miente.

**Nace en borrador y se registra.** Mientras es borrador se puede tocar; al
registrarla entran los movimientos de mercancía en cada sitio y sale el dinero
del fondo, y a partir de ahí **las líneas no cambian**: documentan lo que se
compró y a qué costo. Corregirse es cancelar y hacer otra, que deja los
movimientos contrarios a la vista. Un borrador que nunca se registró sí se
borra: no llegó a pasar nada.

**Lo que entra repone primero el costo; lo que sobra es ganancia.** Por eso se
enseñan las dos cifras por separado: «recuperado del costo» y «ganancia
encima». Vender por debajo del costo recupera menos y no genera ganancia, que es
lo que pasa de verdad.

**Cuentan las dos formas de que salga mercancía y entre dinero**: la venta
directa en la caja y la que se lleva un trabajo. **La merma gasta unidades pero
no recupera nada** —es pérdida, no dinero— y por eso se enseña aparte: «de 100
quedan 60» sin decir que 10 se rompieron es un descuadre que nadie sabría
explicar.

**El mismo producto no puede estar dos veces en una inversión.** Al vender una
unidad no se sabría a cuál de los dos costos apuntarla, y el porcentaje saldría
distinto según cómo se mirara.

**Una línea puede no llevar producto: entonces es DINERO con un concepto.** El
transporte, un ayudante, la comida de la obra. No entra en el inventario porque
no es mercancía, pero sale del fondo igual y cuenta en el importe. Se decidió el
13 de agosto de 2026, cuando quedó claro que «saco 50 del fondo para el trabajo»
no cabía en ningún sitio: eso empujaba a apuntarlo como gasto suelto, que es
justo lo que se quería dejar de hacer. **El concepto es obligatorio**: dentro de
un mes, «50» a secas no lo explica nadie.

El importe sigue saliendo de las líneas, así que no hay dos formas de calcular lo
mismo: una línea de dinero lleva cantidad 1 y su importe en el costo.

**El costo del movimiento va en CUP y el de la inversión en su moneda.** El
inventario entero vive en pesos; una inversión se puede hacer en dólares. Al
registrarla se congela el cambio de ese día: dentro de un año esa compra siguió
costando lo que costó.

## 20. La aplicación se salva sola.

Copia entera de la base de datos al arrancar y cada pocas horas
(`DP_SALVAS_CADA`), guardando las últimas 30 y tirando las viejas. Se hace con
el copiado en caliente de SQLite, que saca una copia coherente aunque en ese
momento se esté cobrando algo; copiar el archivo con el explorador mientras la
app trabaja puede dar una copia rota que parece buena hasta el día que hace
falta.

**Por qué:** la aplicación vive en la máquina de un local, sin nadie que la
cuide, y esa máquina se apaga todos los días. La salva de arranque es la que
garantiza que siempre haya una copia reciente aunque el programa no llegue a
estar seis horas seguidas vivo.

Las salvas **se ven en Ajustes** y se pueden descargar. Una salva que nadie ha
mirado nunca es una salva en la que no se puede confiar el día que hace falta.
Y hay que llevarse una **fuera de la máquina** de vez en cuando: una copia que
vive en el mismo disco que el original no salva de que ese disco se rompa.

**Nota aparte:** en esta aplicación casi nada se borra de verdad. Los
movimientos son inmutables, anular mete el contrario, y los productos, clientes
y plantillas se marcan como inactivos. Lo que las salvas protegen no es un
borrado accidental —que casi no puede pasar— sino perder el archivo entero.
## 21. El negocio se mide en UNA moneda, y cada venta congela su cambio.

Hay dos cosas distintas que la aplicación no puede confundir:

- **El efectivo**, que es lo que entra en cada gaveta. Los pesos son pesos y los
  dólares son dólares, van separados y no se suman nunca. El fondo, el conteo de
  billetes y el cobrado del día son esto.
- **La medida del negocio**: los costos, el valor del almacén, las ganancias y
  las comisiones. Eso tiene que estar en **una sola moneda**, o no se puede
  restar un costo de un ingreso y la palabra «ganancia» no significa nada.

Cuál es esa moneda lo decide el dueño en Ajustes (`ajustes.moneda_base`). Aquí
se compra en dólares y se vende sobre todo en pesos, y el peso se devalúa por
debajo: midiendo en pesos, un almacén que no ha cambiado parece valer más cada
mes y las ganancias salen infladas por la inflación, no por vender mejor.

**Cambiarla convierte lo guardado, de una vez.** Los costos de los productos, el
de cada movimiento, y el costo y la comisión de cada venta. No se convierte al
leer: si se hiciera así, las ganancias de un mes cerrado cambiarían cada vez que
alguien tocara el valor del dólar. Por eso el botón avisa, pide el cambio, pide
confirmar dos veces y manda hacer una copia antes. No tiene marcha atrás salvo
recuperar esa copia.

**Cada venta guarda el cambio de su día** (`ventas.tasa`). Una venta cobrada en
pesos se mide en la moneda del negocio con el dólar que había ese día, no con el
de hoy. Sin esto, subir el dólar en Ajustes movería las ganancias de todos los
meses anteriores —incluidas las jornadas ya cerradas—, y un cierre es un
documento contable: si cambia después de firmado, no sirve para nada
(decisión #5).

**Lo que NO se convierte:** las líneas de una inversión y las de una cotización,
que llevan su propia moneda declarada. Esas siguen valiendo lo que decía el
papel que se firmó.

**Y al lado, siempre, la otra moneda.** Añadido el 14 de agosto de 2026 a
petición del dueño: la medida es una sola, pero los totales que importan —la
ganancia de la jornada, la del período, el valor del almacén— se enseñan también
en la otra moneda entre paréntesis. Son el mismo dinero contado de dos formas y
**no se suman jamás**; están para saber de cuánto se habla sin hacer la cuenta
de cabeza.

**Dos sitios donde esto se rompió, y hay que no repetirlos:**

1. La casilla del costo de un producto convertía a **pesos siempre**, midiera el
   negocio en lo que midiera. Con la medida en dólares, escribir un costo de 300
   guardaba 36 000, el servidor lo leía como 36 000 dólares y la ganancia de cada
   venta de ese producto salía absurda. No se ve en ninguna pantalla hasta que
   las cuentas del mes no cuadran. Por eso ahora, además, **un costo por encima
   del precio sale en rojo** en el catálogo: la aplicación no sabe cuál era el
   número bueno y no lo inventa, pero sí puede decir cuál mirar.
2. Las comisiones sumaban lo vendido con un `SUM(v.total)` de SQL, y ahí caían
   juntas las ventas en pesos y las ventas en dólares. **Ninguna suma de dinero
   se hace en SQL** si las filas pueden traer monedas distintas: se convierte
   fila a fila, con el cambio congelado de cada venta.

**En qué moneda se le paga a cada trabajador** es otra cosa y va aparte
(`personas.moneda_pago`). La comisión se **mide** en la moneda del negocio,
como todo; lo que hay que darle se enseña en la suya. Vacío = la del negocio, y
no se guarda cuál es en ese momento: si mañana cambia la moneda del negocio,
quien no eligió nada tiene que seguir cobrando en la que se mida entonces.

## 27. Cada sitio tiene su gaveta, y el dinero se pasa en dos mitades.

Pedido del dueño el 14 de agosto de 2026: «hay un fondo general que es el del
almacén principal y debe haber un fondo individual por tienda; de ese fondo
quiero poder pasar de una tienda a otra».

**El saldo de un sitio es la suma de sus apuntes**, como todo lo demás en esta
aplicación: no hay ninguna columna «saldo» que mantener (decisión #1). En un
punto, la pantalla de Dinero enseña **su gaveta** —el dinero que quien está allí
puede ir a contar a mano— y debajo, en pequeño, el del negocio entero. En el
almacén principal manda el general, porque es el mirador (decisión #22).

**Los apuntes que no son de ningún sitio** —retiros, inversiones y gastos del
negocio— no se reparten entre los puntos. Si se repartieran, la gaveta de cada
uno dejaría de cuadrar con el dinero que hay dentro, que es justo para lo que
sirve. Van en su propia fila, «Del negocio».

**Un traspaso son DOS apuntes**, no uno: un retiro donde estaba el dinero y un
ingreso donde va, enlazados por el mismo `ref_id`. Es la misma forma que tiene
un traslado de mercancía, y por el mismo motivo: los apuntes son inmutables
(#2), cada lado escribe lo suyo, y el fondo general no se mueve porque las dos
mitades se compensan.

**Un traspaso no es dinero que entre ni salga del negocio.** Se marca con
`ref_tipo='traspaso'` y queda fuera del resumen del período. Si contara, pasar
100 de una tienda a otra saldría como 100 de ingresos y 100 de retiros, y el
resumen del mes diría que entró dinero que no entró.

**Las dos mitades van en la misma moneda.** Cambiar pesos por dólares no es
pasar dinero de sitio: es una compraventa, con su cambio y su ganancia o su
pérdida, y meterla aquí escondería esa cuenta dentro de un traspaso.

**No se puede sacar más de lo que hay**, y al negarse se dice cuánto hay. Una
gaveta en negativo no existe: significa que falta un apunte o que alguien se
equivocó de sitio, y descubrirlo tres semanas después no lo arregla.

## 22. El almacén principal es el mirador del negocio.

Quien está en el **almacén principal** es quien lleva las cuentas de todo, así
que desde allí las pantallas enseñan **todo el negocio sumado y, debajo, sitio
por sitio**: en Cierre (la jornada y el período), en Dinero y en el Almacén.
Estando en un punto no cambia nada: se ve lo de ese punto, que es de lo que
responde quien atiende. Lo eligió el dueño el 13 de agosto de 2026.

**No es una pantalla nueva.** Son las de siempre, contestando desde donde se
está. Una pantalla más que aprender es una pantalla más que nadie abre.

**Cuál es el almacén principal se decide en un solo sitio**: el primer almacén
que se creó. El servidor ya usaba esa regla para meter la mercancía que una
inversión no reparte. Si la pantalla eligiera otro, la mercancía entraría en un
almacén y se enseñaría en otro.

**Y en el Almacén, el mirador ya no manda ni con varios sitios.** El mismo día, y
después de ver lo de arriba, el dueño lo pidió claro: el Almacén tiene que abrir en
**«solo lo que hay aquí»** y en **«todo el catálogo»**. Lo primero que quiere ver al
entrar es su estante, no una suma; y filtrando por existencia, un producto recién
creado no aparece y parece que no se guardó. La vista de todo el negocio sigue
estando a un toque del desplegable cuando haya más de un sitio. **La #22 se queda
entera para Cierre y Dinero**, que es donde de verdad se llevan las cuentas de todo.

**Y el mirador se apaga cuando no hay nada que mirar. Vivido el 1 de septiembre
de 2026.** Este negocio tiene, de momento, **un solo sitio**. Con uno solo, «todo
el negocio sumado» enseña exactamente lo mismo que «lo que hay aquí» —no suma
nada— y a cambio **esconde los botones de Entrada, Merma y Despachar**, porque
una entrada tiene que ir a un sitio concreto y no «a todos». El resultado era una
pantalla de Almacén **sin ninguna forma de meter mercancía**: el dueño entraba,
veía «Todo el negocio, sumado», ni un botón, y una lista vacía. Preguntó dónde
estaba la opción de entradas, y la respuesta honrada era que no estaba.

Así que **con un solo sitio el desplegable de alcance no se enseña** y el Almacén
se queda siempre en «lo que hay aquí»; **Despachar se esconde** mientras no haya
otro sitio al que mandar. Vuelven los dos, solos, el día que se cree un punto de
venta. Nada que configurar, y la regla de arriba intacta.

**La otra mitad del mismo susto:** el Almacén abre filtrando por «Con
existencia», así que un catálogo recién creado —productos sin entradas todavía—
salía entero vacío bajo un «Nada que mostrar con este filtro» que se lee como
«no se guardó». Ahora la lista vacía dice **cuál de las dos cosas es**: si no hay
productos, o si los hay y ninguno tiene mercancía; y en ese caso ofrece verlos
todos y recuerda que la mercancía entra por el botón «Entrada».

**Lección, que no es sobre almacenes:** una vista pensada para el negocio grande,
puesta delante del negocio pequeño, no da error — **quita opciones en silencio**.
Al recortar esta aplicación se miró qué pantallas sobraban; no se miró qué
pantallas se quedaban a medias con un solo sitio.

**Lo que pasó y lo que hay son dos tablas distintas, nunca una.**

| | Qué es | Ejemplos |
|---|---|---|
| **Lo que se movió** | un flujo: lo ocurrido entre dos fechas | vendido, ganancia, mermas, entradas, retiros |
| **Lo que hay ahora** | un saldo: desde el principio hasta hoy | el dinero de cada gaveta, el valor del inventario |

Juntarlas en una sola tabla sería la forma más rápida de que alguien lea «tiene
90 000» donde pone «vendió 90 000». Por eso van separadas y cada una dice en su
pie qué está contando.

**El dinero que no es de ningún punto tiene su propia fila.** Los retiros, las
inversiones y los gastos del negocio se apuntan sin sitio. Repartirlos entre los
puntos dejaría la gaveta de cada uno sin cuadrar con el dinero que hay dentro de
verdad, que es justo para lo que sirve: poder ir y contarlo. Por eso hay una
fila «Del negocio», y por eso la suma de todas las gavetas es exactamente el
saldo del fondo.

**El total es la suma de las filas, sin atajos.** No hay una consulta aparte que
calcule el total por su cuenta: se suman las filas que se están enseñando. Si
algún día no cuadrara, se vería en la propia pantalla en vez de esconderse. Y se
redondea al final, nunca cada fila: redondeando antes, las filas y el total
dejarían de coincidir por unos pesos y no habría forma de explicarlo.

**Quien no puede ver un número, no lo recibe** (decisión #10). Sin
`ver_ganancias` no salen ni costos ni ganancias ni el valor del inventario; sin
permiso sobre el dinero no sale ninguna gaveta —ni la fila «Del negocio», que es
solo dinero—. No se esconden en la pantalla: no salen del servidor.

**Y un apunte anulado no cuenta.** Se mira que el movimiento siga *en pie*, o
sea que no anule a nadie y que nadie lo haya anulado a él. Mirar solo
`anula_a IS NULL` deja pasar el anulado —la marca la lleva el contrario, no él—
y la misma merma salía con dos cifras distintas según la pantalla desde la que
se mirara.

## 25. En Ajustes se entra por un índice, no por una lista de quince tarjetas.

El 13 de agosto de 2026 el dueño lo dijo tal cual: «hay demasiadas opciones y me
pierdo». Eran quince tarjetas seguidas y había que recorrer media pantalla para
encontrar cualquier cosa. Ahora Ajustes abre en un **índice de cinco apartados**
—El negocio, La gente, El sitio web, Copias y aparatos, Este aparato— y solo se
ve el que se elige.

**Un apartado del que este cargo no pueda ver ni una tarjeta no sale.** Y eso se
decide mirando lo que ha quedado visible después de aplicar los permisos, no
repitiéndolos en el botón del índice: así, al añadir mañana una tarjeta nueva,
el índice sigue acertando solo.

**De paso, dos tarjetas se llamaban «Copia de seguridad»** y eran cosas
distintas: una guarda la base entera y la otra junta lo de dos aparatos. La
segunda pasa a llamarse **«Juntar aparatos»**. Dos tarjetas con el mismo nombre
en la misma pantalla es pedirle a alguien que se equivoque.

## 24. Las ganancias se ven en Dinero, y cada una en su sitio.

Hasta el 13 de agosto de 2026 las ganancias solo salían en Cierre, y el dueño no
las encontraba. Ahora están en **Dinero**, con una fila por tienda o almacén y el
total del negocio, como todo lo demás (#22).

**Y desde el 14 de agosto, dentro de la tarjeta de cada sitio.** Estaban en su
propia tabla, aparte del dinero de ese mismo sitio, y encima había una tercera
tarjeta con el total del período del negocio entero. El período aparecía **tres
veces en la misma pantalla** y ninguna se podía comparar con las otras: para
saber qué había hecho una tienda —cuánto entró, en qué se fue y cuánto ganó—
había que juntar tres trozos a ojo.

Ahora es **una tarjeta por sitio con todo lo suyo**, y el negocio entero es la
última, con la misma forma. Cada cosa se hace en una tienda; el total es la
suma, y por eso va al final y no arriba. Lo pidió el dueño con esas palabras:
«todas esas cosas se pueden hacer individualmente por cada tienda y se ven
reflejadas como total en el almacén principal».

**Una tarjeta y no una tabla:** son cinco conceptos de dinero en dos monedas más
las tres cifras de la ganancia. En una tabla eso son doce columnas, y en un
teléfono no se lee ninguna. Un concepto que está en cero en las dos monedas ni se
pinta: llenar la tarjeta de ceros esconde el número que sí importa.

**Es la ganancia BRUTA**: lo vendido menos lo que costó esa mercancía, más lo que
dejó cada trabajo. No se le restan las comisiones ni lo que salió del fondo, y es
a propósito: eso mezclaría el mes con compras que sirven para los meses
siguientes, y la cifra dejaría de contestar la única pregunta que se le hace:
¿este sitio gana dinero vendiendo?

**Cada ganancia va donde se generó** (#19): la de las ventas y la de los
materiales de los trabajos, en el sitio; la de la mano de obra, en la fila del
negocio. Los trabajos cuentan por la fecha en que se **cobraron**, que es cuando
entró el dinero, no por la del papel.

## 28. Un aviso no es un dato: es una forma de mirar los que ya hay.

Pedido del dueño el 14 de agosto de 2026: «que diga cuándo se recibió un pedido
de la web, que avise cuando se recibe un comentario o una valoración».

**No hay tabla de avisos.** Un pedido está pendiente si no tiene respuesta, una
opinión si no tiene decisión, un mensaje si no está leído. Se calcula, como el
stock (#1). Con una tabla habría dos verdades —la lista de avisos y el estado de
verdad— y en cuanto se desincronizaran, la campanita estaría avisando de un
pedido que alguien ya despachó en otro aparato.

**Dos capas, y la de abajo es la que importa:**

1. **La campanita**, con el número de cosas sin atender. Se ve al abrir la
   aplicación, funciona sin internet, sin permisos y en cualquier teléfono.
2. **El aviso del teléfono**, el que sale arriba con sonido. Hay que pedirlo y
   solo llega con la aplicación abierta.

Si la segunda no está, la primera sigue haciendo su trabajo. **Al revés no**, y
por eso el aviso del sistema nunca es el único sitio donde se entera uno: un
aviso que solo existe en la barra del teléfono lo borra cualquiera sin leerlo.

**El permiso se pide con un botón, nunca al arrancar.** Preguntarlo nada más
abrir es lo que hace que la gente le dé a «Bloquear» sin leer, y entonces ya no
hay forma de volver a preguntarlo: hay que ir al candado de la barra de
direcciones, que no va a hacer nadie.

**Lo pinta el service worker** (`showNotification`) y no el constructor suelto:
en Android el segundo no funciona dentro de una aplicación instalada, que es
justo donde se usa. Y tocarlo **trae la aplicación a la pantalla** en vez de
abrir otra copia, que dejaría dos ventanas de la caja con el carrito a medias en
una de las dos.

**«Esto ya te lo enseñé» es de cada aparato**, y por eso vive en el aparato. Si
viviera en el servidor, el primero en verlo dejaría a los demás sin enterarse.
Se apunta **aunque no haya permiso**: si no, el día que alguien lo diera saldrían
de golpe veinte avisos viejos.

**A quien no puede atender algo no se le avisa de ello.** Quien solo vende no
recibe los pedidos de la web: avisar de algo que uno no puede tocar es la forma
más rápida de enseñar a ignorar los avisos.

**Lo que sabe solo el aparato lo pone el aparato**: la mercancía que se está
acabando —del sitio donde se está, que al de al lado no le sirve— y la versión
nueva. Lo del stock se recalcula **justo después de cobrar**, que es cuando
sirve: quien está en el mostrador puede apuntarlo antes de que se le olvide.

**Un mensaje se da por leído al abrir la lista.** No hay nada más que hacer con
él aquí —se contesta por teléfono—, así que obligar a marcarlos uno a uno solo
serviría para dejar la campanita encendida para siempre.

## 29. Se puede borrar, y por eso está atado con cuatro nudos.

Pedido del dueño el 14 de agosto de 2026. Va contra la decisión #2 —los apuntes
no se editan ni se borran— y contra la #5 —un día cerrado no se toca—, y aun así
tiene que existir: se ha estado probando la aplicación con datos inventados y
hay que empezar con los de verdad. La alternativa era entrar a la base de datos
del servidor a mano, que es mucho peor: allí nadie sabe qué se lleva por delante
cada tabla.

**Los cuatro nudos**, y ninguno sobra:

1. **Solo el administrador.** No es un permiso que se pueda dar a un cargo, a
   propósito: no hay ningún trabajo que necesite borrar el histórico.
2. **Se hace una copia antes, siempre**, y se dice cómo se llama. Si la copia
   falla, no se borra nada.
3. **Hay que escribir la palabra BORRAR.** Un «¿seguro?» se pulsa sin leer; una
   palabra hay que teclearla mirando.
4. **Se enseña cuánto hay de cada cosa** antes de elegir. «¿Seguro?» no es una
   pregunta si uno no sabe qué se está llevando por delante.

**Los grupos no son las tablas: son las cosas como las entiende quien las
borra.** «Ventas, mercancía y días» se lleva las ventas, los movimientos, los
conteos, los días y los apuntes del fondo que salieron de una venta. Si fueran
tablas sueltas, cualquiera dejaría un inventario que no cuadra con ninguna venta.

**Y lo que arrastra a otra cosa se marca solo.** Borrar el catálogo dejando las
ventas dejaría apuntes de productos que ya no existen. La pantalla marca lo que
hace falta y lo dice; el servidor lo comprueba otra vez y lo rechaza si no viene
(#10: esconder un botón es decoración).

**Lo que NO se borra nunca desde aquí:** los sitios, el personal, los cargos y
los ajustes del negocio. Sin eso no se puede ni entrar a la aplicación, y quien
quiere empezar de cero quiere empezar a vender, no a configurar.

**Aviso de las otras copias.** Borrar en un dispositivo no borra en los demás, y
la próxima vez que se junten volverán a entrar los datos que ellos tengan. Se
dice en la pantalla cuando hay más copias apuntadas. No se intenta arreglar
solo: un borrado que se propaga por la sincronización es la forma más rápida de
perder el negocio entero por un dedo torpe en el teléfono equivocado.

---

## 30. Un costo mal escrito se corrige con pruebas, no con un número inventado

Entre el 12 y el 14 de agosto de 2026 la casilla del costo convertía a pesos
**siempre**, midiera el negocio en lo que midiera. Con la medida en dólares,
escribir 300 guardaba 120 000 y el servidor lo leía como 120 000 **dólares**. El
código está arreglado desde `effd938`, pero **arreglar el código no repara lo
que quedó escrito**: ese costo sigue en el catálogo, en los apuntes del
inventario, en el costo congelado de cada venta y en el de cada trabajo. De ahí
salían las ganancias en negativo que reportó el dueño.

La primera respuesta fue marcarlo **en rojo** en el catálogo y dejar que él lo
repasara a mano, con este argumento: *la app no sabe cuál era el número bueno, y
ponerle uno inventado sería peor que el fallo*. El argumento sigue siendo
válido; lo que estaba mal era la conclusión. **La app sí tiene la prueba de lo
que costó de verdad**: la línea de la inversión con la que ese producto entró,
que salió de una factura.

Así que **Ajustes → El negocio → Repasar los costos** propone, en este orden:

1. **Lo que costó según la última inversión registrada** de ese producto.
2. Si nunca entró por una inversión, **deshacer la conversión de más**: el costo
   guardado dividido por el valor del dólar, que devuelve exactamente la cifra
   que se tecleó.
3. Y siempre se puede **escribir el número a mano**, que es lo que manda.

Nada se aplica solo. Los frenos son los mismos que los del borrado (#29): la
palabra **CORREGIR** escrita, comprobada en el servidor y no solo en la
pantalla; **copia de seguridad automática antes** y fuera de la transacción, de
modo que si la copia falla no se toca un número; y todo dentro de una sola
transacción, para que no queden unos productos arreglados y otros no.

**Lo que arrastra, y por qué se arrastra.** Cambiar solo el catálogo dejaría las
ganancias de atrás igual de mal. Así que con el mismo costo se corrigen:

| Dónde | Qué se toca |
|---|---|
| `productos` | El costo y el de reposición, con la misma proporción |
| `movimientos` | **Solo los apuntes que llevan EXACTAMENTE el costo malo** |
| `ventas` | El costo se vuelve a **sumar** de sus líneas, no se escala |

Las dos negritas son la regla: **aquí no se reescribe la historia, se corrige un
error**. Si un producto entró tres veces a precios distintos, los otros dos eran
correctos y no se tocan. Y el costo de una venta se vuelve a sumar de sus
apuntes en vez de multiplicarlo por un factor, para que quede cuadrado aunque la
venta llevara varios productos y solo uno estuviera mal.

**Quién puede.** Ver la lista pide `ver_ganancias`, porque enseña los costos de
todo el catálogo (#10). Corregir pide **además** `gestionar_productos`: cambia
ganancias que ya están apuntadas.

Probado de punta a punta en `pruebas/monedas.js`, reproduciendo el accidente
real: producto a 600 USD con un costo de 120 000, su inversión de 300, una
entrada y una venta hechas con el costo malo. Se comprueba que lo propone bien,
que sin la palabra no toca nada, que la venta deja de costar más de lo que se
cobró, y que **los apuntes de la inversión, que estaban bien, no se tocan**.

---

## 31. Editar un apunte de dinero es anularlo y volver a apuntarlo

Pedido del dueño el 16 de agosto de 2026: «necesito poder editar y borrar los
retiros, ingresos y gastos». Es lo mismo que pide cualquiera que se equivoque
tecleando, y choca de frente con la decisión #2. La salida no es hacer una
excepción: es que **por fuera se vea un botón de editar y por dentro no se
reescriba nada**.

**Anular es meter el MISMO tipo de apunte con el importe en negativo.** Parece
un rodeo y es lo contrario. Todas las cuentas del negocio —el saldo del fondo,
la caja de cada sitio, el resumen del período por tipo, el mirador del almacén—
suman `importe` y le ponen el signo según el `tipo`. Un negativo del mismo tipo
se cancela **solo, en todas ellas, sin tocar una sola consulta**. Con el apunte
del tipo contrario el saldo también habría cuadrado, pero el mes habría quedado
con un ingreso y un retiro que nunca existieron: el mismo enredo que obligó a
apartar los traspasos de los resúmenes (#27).

**Editar es anular y volver a apuntar**, las dos cosas dentro de una
transacción. En la lista queda el apunte bueno y ya está.

**La fecha del apunte contrario es la del original, no la de hoy.** Esto no es
un hecho nuevo, es la corrección de un error: con la fecha de hoy, el mes en el
que se apuntó mal se quedaría descuadrado para siempre y el de ahora arrastraría
un dinero que no se movió. Lo que sí lleva la hora de ahora es `creado_en`, que
es lo que cuenta **cuándo** se corrigió.

**Solo los apuntes hechos a mano.** Los que vienen de una venta, de una
inversión, de un trabajo o de un traspaso tienen otro dueño (#3): si se borrara
aquí el dinero de una venta, el fondo diría una cosa y la venta otra, y ya no
habría forma de saber cuál de las dos miente. Al pulsar se contesta **dónde se
deshace cada uno**, que es lo que hace falta saber. Y una anulación no se anula:
eso solo sirve para dejar el histórico ilegible.

**En la lista no salen ni el apunte anulado ni su anulación**, porque suman cero
y solo estorban a quien acaba de corregir algo. Salen marcando «Ver también los
anulados», tachados: el histórico está entero y hay que poder mirarlo.

De paso, dos cosas que faltaban en el mismo formulario: **la fecha** (era
siempre hoy, así que un gasto de ayer apuntado esta mañana caía en el mes que no
era) y **quién lo apuntó** (la ficha decía «Registrado por —» pasara lo que
pasara, porque nadie rellenaba ese campo).

### Y un cargo se da de baja, no se borra

Segunda mitad del mismo pedido: se crearon cargos probando la aplicación y no
había forma de quitarlos. Tres frenos:

1. **El de administrador nunca.** Sin él nadie podría volver a entrar.
2. **Un cargo que alguien tiene puesto no se va**, y se dice **quién** lo tiene.
   Los permisos se leen del cargo en cada petición: si el cargo desapareciera,
   esa persona se quedaría sin permisos de golpe y sin saber por qué.
3. **La fila no se borra: se le pone la fecha de la baja**, como a los artículos
   de la web. Una fila que desaparece no viaja en la sincronización, así que el
   cargo volvería a salir en cuanto se juntaran dos copias.

Lo que hizo la gente que tuvo ese cargo **no se toca**: los apuntes son suyos,
no del cargo.

`pruebas/correcciones.js`, **46 comprobaciones** de punta a punta. Las que
importan son las que miran por caminos distintos: que el saldo vuelva
*exactamente* a donde estaba, que el resumen del período no se quede con lo
anulado, que la gaveta del sitio —que es otra consulta— cuadre igual, y que la
baja del cargo **viaje en el paquete de sincronización**.

---

## 32. La comisión del día es del día, no de quien marcó la venta

Pedido del dueño el 17 de agosto de 2026: «necesito poder poner el trabajador o
trabajadores que trabajaron ese día para atribuirle las comisiones, el reparto
será proporcional para cada trabajador del día a partes iguales».

Hasta ahora la comisión de una venta era de quien la marcaba (`ventas.persona_id`).
Suena justo y no lo es: **en el mostrador marca la venta quien tiene el teléfono
en la mano**, no quien cargó la mercancía ni quien atendió al cliente. Con un
aparato por punto, eso significaba que el sueldo variable de todo el día se lo
llevaba una persona por un detalle de logística.

**El reparto se hace por día y por sitio, a partes iguales.** Se suma la comisión
de todas las ventas de ese día en ese sitio y se divide entre los apuntados.

**Los días sin lista siguen contando como antes.** No es una concesión: es lo que
permite desplegar el cambio sin tocar un solo día pasado. Los meses ya cerrados
no tienen lista de gente, así que siguen diciendo exactamente lo que decían ayer.
Si algún día se hubiera decidido «sin lista no hay comisión», el mes en curso se
habría quedado a cero de golpe.

**Lo vendido se sigue atribuyendo a quien despachó.** Son dos preguntas
distintas —«¿quién atendió?» y «¿a quién le toca el dinero?»— y juntarlas en una
sola cifra no contestaría ninguna de las dos.

**La lista se apunta al cerrar la jornada**, que es el momento en que ya se sabe
con certeza quién trabajó, y eligió ese sitio el dueño entre tres. Se puede
guardar sin cerrar el día, para marcarla por la mañana.

**Un día ya cerrado: solo el administrador puede corregir la lista, y sin
reabrir la jornada.** Esto parece ir contra la #5 y no va: olvidarse de marcar a
alguien significa que **esa persona no cobra**, y la alternativa —reabrir el
día— es peor, porque un día reabierto vuelve a aceptar ventas, entradas y mermas
con esa fecha. Cambiar la lista no mueve una unidad de inventario ni un peso de
la caja: solo cambia entre cuántos se divide una comisión que aún no se ha pagado.

**Desmarcar a alguien es poner `presente` en 0, no borrar la fila.** Una fila que
desaparece no viaja en la sincronización: al juntar dos aparatos, la persona
desmarcada volvería del otro lado y cobraría sin que nadie la hubiera marcado. Es
la misma lápida que `cargos.borrado_en` y los artículos de la web.

### Y pagar una comisión es dinero que sale de una caja

Segunda mitad del mismo pedido: «necesito ver la estadística del dinero
acumulado que ha cobrado cada trabajador en el mes». Eligió ver **las dos
cifras**: lo que le toca y lo que ya se le entregó.

Para saber lo entregado hay que apuntarlo, y apuntarlo de verdad: un pago de
comisión es un **retiro del fondo** como cualquier otro. Si fuera un número
guardado aparte, el saldo de la app diría que hay un dinero que ya no está.

**El pago se apunta contra el MES que se paga, no contra el día en que sale el
dinero.** La fecha del apunte es la de hoy —el dinero sale hoy—, pero `ref_id`
lleva el mes (`2026-08`). Sin eso, pagar el 2 de septiembre la comisión de agosto
dejaría agosto diciendo para siempre que no se ha pagado nada, y septiembre con
una salida de dinero sin motivo.

**Lo que queda se resta solo dentro de la misma moneda.** Si a alguien se le pagó
parte en pesos y parte en dólares, no se inventa una conversión con el dólar de
hoy para cuadrarlo: se enseñan los dos números y se dice que hay que verlo a mano
(#21).

**A quién se le paga va en una columna nueva, `fondo.beneficiario_id`**, y no en
`persona_id`, que ya significa **quién apuntó** el movimiento y sale en la ficha
como «Registrado por». Reutilizarla habría hecho que la ficha del pago dijera que
lo registró la persona que lo cobró — exactamente el tipo de nombre reutilizado
que ha costado tres fallos en esta aplicación (`por_pago`, `gaveta`, `c.total`).

**El pago tiene dueño, así que no se toca desde Dinero** (#31): al intentarlo se
dice que se deshace en Comisiones. Y su anulación **copia el `ref_tipo`**, porque
si no, la suma de lo pagado no restaría la devolución y la app diría para siempre
que alguien cobró un dinero que devolvió.

### Y el valor del dólar lo pone solo el administrador

Tercera parte del mismo día. Lo cambiaba cualquiera con permiso para editar
productos, y ese número **no es un dato de un producto**: con él se calculan los
precios en la otra moneda de todo el catálogo, lo que se cobra en la caja, el
valor del almacén y las comisiones. Un cero de más puesto por quien estaba
etiquetando mercancía mueve todas esas cifras a la vez y ninguna pantalla grita.
Se cerró igual la **moneda del negocio**, que es peor todavía: reescribe todos
los costos guardados y no tiene botón de deshacer. **Leer** el valor sigue
abierto a todos: sin él, quien está en la caja no puede cobrar en la otra moneda.

### Y cada uno se cambia su PIN

Cuarta parte. Antes solo lo cambiaba el administrador —está escrito en el propio
`server.js` que «es como debe ser»— y el dueño pidió lo contrario. Tiene razón
práctica: el PIN lo pone el administrador al crear la cuenta, así que hay un rato
en que **dos personas conocen la llave de un usuario**. Que cada uno se ponga el
suyo al entrar cierra ese rato.

**Hace falta el PIN de ahora** para cambiarlo: sin eso, un teléfono desbloqueado
encima del mostrador es una cuenta regalada. **Se cierran las demás sesiones y no
la propia**: cerrarlas todas te echaría de la aplicación al cambiar tu propio
PIN, y no cerrar ninguna dejaría dentro para siempre al teléfono que se perdió.
El administrador conserva su llave maestra, que es lo que hace falta cuando
alguien olvida el PIN de verdad.

`pruebas/comisiones.js`, **78 comprobaciones** de punta a punta. Las que importan
son las que miran por otro camino: que **la suma de lo que cobra la gente sea
exactamente la comisión del día** (repartir no puede inventar ni perder dinero),
que el desmarcado **viaje en el paquete de sincronización**, que el saldo vuelva
*al céntimo* al deshacer un pago, que la gaveta del sitio —otra consulta— baje
igual, y que pagar en un mes lo de otro salga en el mes que se generó.

---

## 33. La ganancia no cambia de significado: debajo se enseña lo que cuesta la gente

Preguntado por el dueño el 17 de agosto de 2026: «cuando se habla de ganancias,
¿se está teniendo en cuenta restar las comisiones y salarios de trabajadores? eso
debería salir en los desgloces». **No se estaba.** La ganancia era —y sigue
siendo— lo vendido menos lo que costó la mercancía. La comisión se calculaba y se
enseñaba **al lado**, sin restar, y los salarios solo existían como apuntes de
dinero escritos a mano: bajaban el saldo de la caja y no aparecían en ninguna
cuenta de ganancia.

**No se cambia lo que significa «Ganancia».** Eligió que siga valiendo lo que
vale y que debajo aparezcan las restas y un **«Queda después de la gente»**. Las
dos cifras hacen falta y contestan preguntas distintas: la primera dice si se
está vendiendo bien —si el margen del comercio es el que tiene que ser—, y la
segunda dice si al final del mes sobra algo. Cambiar el número de arriba habría
hecho que todas las cifras que el dueño ya tiene vistas bajaran de golpe, sin
forma de comparar con lo de antes.

**Se resta lo GENERADO en el período, no lo entregado**, y eso son dos sumas que
no se pueden mezclar:

- Las **comisiones** salen de las ventas de esas fechas, se hayan pagado o no.
- Los **salarios y adelantos** no se generan solos en ningún sitio: existen
  cuando alguien los apunta. Para esos, lo apuntado con fecha de esas fechas.

Con lo entregado, un mes en que se pagaran dos meses atrasados saldría horrible y
el mes anterior saldría regalado.

**Y aquí está la trampa que hay que evitar: la comisión no se puede restar dos
veces.** El pago de una comisión también es dinero para la gente. Si se sumara,
se restaría una vez al generarse y otra al pagarse. Se deja fuera por su
`ref_tipo`, y hay una prueba que paga una comisión y comprueba que el resumen del
período **no se mueve**.

**Qué es «dinero para la gente» lo dice una columna, `fondo.es_gente`, no una
lista de palabras.** El subtipo lo escribe la persona: hoy hay «Salarios»,
«Salario de jefe» y «salario», y mañana habrá «pago a los muchachos». Adivinar por
el texto es exactamente lo que ya ha fallado tres veces aquí. La casilla viene
**marcada de antemano** cuando el tipo de apunte ya lo dice, para que no dependa
de que alguien se acuerde.

Lo ya apuntado **sí se marcó leyendo el texto**, con una migración que corre **una
sola vez** y deja su marca en `ajustes`. Sin esa marca volvería a correr en cada
reinicio, y un apunte que el dueño hubiera decidido no contar se volvería a marcar
solo cada vez que se reinicia el servidor.

**La anulación de un salario copia la marca.** Sin eso, el negativo se quedaría
fuera de la suma y un salario mal apuntado se seguiría restando de la ganancia
para siempre. Es el mismo detalle que en los pagos de comisión.

Sale en los cuatro desgloses: el **cierre de la jornada**, el **resumen del
período**, la **tarjeta de cada sitio** del mirador del almacén y los **dos PDF**.
En la tarjeta de un sitio solo aparece si hay algo que restar: una fila que dice
«menos cero» en cada tienda es ruido.

Comprobado en `pruebas/comisiones.js`: que la ganancia bruta **no se mueva** al
apuntar un salario, que un gasto que no es de la gente no entre en esa cuenta, que
anular un salario lo quite, que pagar una comisión no la reste dos veces, y que la
suma de lo que queda en cada sitio dé el total del negocio.

---

## 35. Un permiso para cada cosa, atado al local, y el jefe metiéndose en la piel

Pedido del dueño el 17 de agosto de 2026: «necesito mejorar el sistema de permisos
disponibles para poner a los roles, necesito permisos para todo lo que existe en la
aplicación y con un sentido lógico», «un trabajador de la tienda solo tendrá
permisos permitidos dentro de esa tienda, no podrá tocar más nada que sea de otro
sitio», y «el admin tiene la opción de ver la aplicación como lo haría ese
trabajador con su rol y sus permisos y puede hacer lo mismo que él».

### Eran 15 permisos para 112 puertas

Uno solo abría media aplicación: `gestionar_dinero` daba a la vez ver la caja,
mover dinero, corregir apuntes, pasar dinero entre cajas, las inversiones y pagar
comisiones. No se podía tener a alguien que apunte gastos y no toque las
inversiones. Y unas veinte pantallas de lectura estaban **abiertas a cualquiera
que entrara**: el resumen del negocio, el catálogo con las existencias de todos los
sitios, las cotizaciones, los traslados.

Ahora son **más de cuarenta**, agrupados por áreas, y la regla al partirlos fue:
**ver y hacer son permisos distintos, y lo que deshace algo va aparte de lo que lo
hace**. Se puede cerrar la jornada sin poder reabrirla, que es donde se tapan los
descuadres; se puede ver qué compras hay en marcha sin ver a qué precio se compró.

**Los cargos que ya existían se traducen**, una sola vez, hacia lo que ya podían
hacer: ni más ni menos. Un cargo que se quedara con permisos que ya no existen
dejaría a esa persona sin media aplicación de un día para otro. Y `POST /api/cargos`
**sigue aceptando los nombres viejos**: un dispositivo con el `app.js` viejo en su
caché los manda así, y filtrarlos a secas dejaría el cargo vacío —o sea, a esa
gente fuera— por haber tocado «Guardar».

### El local: dos piezas, no una

El **alcance** va en el cargo (`cargos.alcance`) y el **local de cada persona** en
su ficha:

- **`propio`** — vale en el local que tenga puesto la persona. Un mismo cargo
  «Vendedor» sirve para todas las tiendas.
- **`lista`** — vale en los locales marcados en el cargo (`cargos.sitios`), sea
  cual sea el local de la persona. Es el «encargado de zona».
- **`todos`** — sin límite.

Las dos piezas hacen falta. Con el alcance **solo** en el cargo, un «Vendedor ·
Tienda Centro» no serviría para el vendedor de otra tienda y habría que duplicar el
cargo entero, con sus cuarenta permisos, y mantener las copias iguales a mano para
siempre. Con el local **solo** en la persona, no se podría dar acceso a dos tiendas.

Un cargo marcado `lista` **sin ningún local marcado no vale en ninguno**, ni en el
de la persona. Lo contrario —valer en todos— sería justo lo que se quiso evitar al
elegir esa opción, y nadie lo notaría hasta que alguien tocara la tienda de al lado.

**Se comprueba en un middleware y no puerta por puerta.** Son más de cuarenta las
que llevan un local, y la que se olvide es justo la que deja pasar. Se mira todo lo
que llegue con nombre de sitio, en la dirección o en el cuerpo.

**Y también los DOS sitios que caben dentro de una línea**, que son la puerta de
atrás de esto y hay que cerrar las dos:

| Dónde | Qué dice | Qué pasaba sin mirarlo |
|---|---|---|
| `lineas[].sitio_id` | de dónde SALE el material | sacar mercancía del almacén escribiéndola en una línea |
| `lineas[].reparto[].sitio_id` | a dónde VA cada unidad de una inversión | meter existencias en un sitio del que no se responde, y sin el traslado que el otro lado confirma |

La segunda faltaba y se cerró el 28 de agosto de 2026. El camino que SÍ está
abierto es el bueno: quedarse la mercancía en su sitio y **despacharla**, que deja
las dos mitades y la confirmación del que recibe (decisión #3).

**No se pasea el cuerpo entero a lo bruto** buscando cualquier `sitio_id` anidado:
el paquete de sincronización trae los movimientos de TODOS los sitios a propósito,
y un paseo recursivo se lo comería. Se miran las formas que existen, y cuando
aparezca una tercera se añade aquí —con su prueba—.

**Con `ver_negocio_entero` se puede MIRAR todo pero no escribir fuera de su local.**
Son dos cosas distintas y el supervisor necesita la primera.

### Hacerse pasar por un trabajador

El motivo, en sus palabras: «no tengo claro lo que quiero que haga cada trabajador,
necesito hacerme pasar por él para ir dando los permisos e irlos confeccionando poco
a poco».

**Dos identidades que no se confunden nunca:**

- **Quien firma** sigue siendo el administrador. Lo que se apunte queda a su
  nombre, porque el registro no puede mentir sobre quién hizo qué.
- **De quién son los permisos** es el otro. Es lo que decide qué se puede hacer, y
  también en qué local.

Vive **en la sesión** y no en el dispositivo: si viviera allí, bastaría con no
mandar el dato para recuperar los permisos de administrador, y esto no sería «ver
como él» sino un adorno. Se vuelve a comprobar en cada petición, así que si le
quitan el cargo de administrador mientras está dentro, deja de poder al momento.
Y **no se puede entrar en la piel de otro administrador**: no enseñaría nada.

Lo hecho en otra piel queda en la tabla **`actuaciones`** (quién firma, en la piel
de quién, qué y cuándo). Contesta la pregunta «¿por qué el jefe apuntó esto a las
once de la noche?». No viaja en la sincronización: es el diario de ese dispositivo,
no un dato del negocio.

### Y la pieza que hace útil todo lo demás

**El 403 dice qué permiso falta, con su nombre en claro y de qué cargo se habla.**
Al chocar con una puerta cerrada, el administrador ve el nombre exacto y un botón
para **dárselo al cargo sin salir de donde está**. Sin eso tendría que adivinar cuál
de los cuarenta era, y para cuando llegara a Ajustes ya no se acordaría.

Se **apunta y se enseña en la tira de arriba**, en vez de saltar una ventana en el
momento: entrar en una pantalla dispara varias peticiones a la vez, y con una
ventana por cada una moverse por la aplicación sería contestar preguntas.

Al dárselo se dice **a cuánta gente afecta**: se le da al CARGO, no a la persona, y
eso sorprende si nadie lo avisa.

### Un fallo que enseña algo

El primer intento contestaba `200` al meterse en otra piel y **no aplicaba nada**:
el `SELECT` de la sesión pedía `s.persona_id, p.*`, y `p.*` no trae las columnas de
la sesión. La nueva se quedó fuera y `como_persona_id` era siempre `undefined`. Es
la peor forma de fallar —sin error, diciendo que sí— y solo la cazó una prueba que
comprobaba los permisos DESPUÉS de entrar, no la respuesta de entrar.

`pruebas/permisos.js`, **61 comprobaciones**. Las que importan son las que mandan
el local ajeno **a mano**, que es lo que haría cualquiera, y las que comprueban que
en la piel de otro se cierran las puertas del administrador.

---

## 36. Las fotos no viajan dentro del catálogo

Preguntado por el dueño el 17 de agosto de 2026: «¿por qué la app carga tan lento?
cuando la abro demora en mostrar los valores y productos». Medido en su base:

```
60 productos · 37 con foto · 1 962 KB en total · la mayor 129 KB
```

**Casi 2 MB de fotos viajaban dentro del JSON del catálogo**, por el internet de un
teléfono, en cada arranque de la aplicación y después de cada venta, antes de que se
viera un solo precio.

Y lo que lo escondía era un **`SELECT *`**: la columna `foto` se añadió después, así
que se colaba en la respuesta sin que nadie tuviera que escribirla en ninguna parte.
De ahí la lista explícita de columnas: lo que viaja al teléfono se decide a mano.

Ahora el catálogo manda **`tiene_foto`** y cada imagen se pide por su propia
dirección, `/foto-producto/:id?v=<fecha>`, con caché de un año. La dirección lleva la
fecha de la última edición: así la caché puede ser eterna —esa versión de la imagen
no cambia nunca— y al cambiar la foto cambia la dirección, que es lo que hace que el
teléfono se entere sin preguntar.

**Va fuera de `/api` a propósito.** Una etiqueta `<img>` no manda la cabecera del
token, así que dentro de `/api` habría que meter el token en la dirección de cada
imagen, y entonces quedaría escrito en el historial del navegador y en los registros
del servidor — justo lo que el resto del programa evita. Que no pida sesión no abre
nada nuevo: es una foto de mercancía, el mismo dato que el sitio web publica en
internet, sin precios, costos ni existencias, y hace falta el UUID del producto, así
que no se puede ir probando números para ver el catálogo.

**El riesgo de este cambio era borrar las fotos, no la lentitud.** Al no venir la
foto en el catálogo, la pantalla ya no la tiene en la mano cuando se edita un
producto, así que al guardar no la manda. Si eso se leyera como «quítala», cambiarle
el precio a un producto le borraría la foto y nadie lo notaría hasta mirar la tienda.
Por eso **no mandar la foto y mandarla vacía significan cosas distintas**: sin el
campo, el servidor deja la que hay; con el campo vacío, la quita, que es lo que hace
el botón «Quitar». Hay una prueba que cambia un precio y comprueba que la foto sigue.

De paso, al arrancar la aplicación pedía el valor del dólar y las denominaciones
**en serie**, esperando a que contestara el primero. Ahora van a la vez: no dependen
una de otra, y cada viaje son unas décimas por el móvil. El catálogo sí espera,
porque necesita saber en qué moneda se mide el negocio para pintar los precios.

`pruebas/materiales.js`: que el catálogo **no contenga ni un `data:image`**, que la
foto se sirva como imagen y con caché larga, y que editar un producto no se la lleve.

---

## 37. El dinero que sale dice de qué caja, y se paga donde está el dinero

Dos cosas pedidas por el dueño el 17 de agosto de 2026, nada más desplegar los
permisos.

### El sitio deja de ser opcional en lo que sale

«Tanto en retiro como en inversiones y gasto necesito que donde dice sitio opcional
sea obligatorio, y que no aparezca la opción *ninguno en concreto*.»

Tiene razón, y esto **matiza la #22**. Allí se decidió que el dinero que no es de
ningún punto —retiros, inversiones, gastos— fuera a una fila «Del negocio», para que
**la suma de las gavetas siga siendo el saldo del fondo**. Eso sigue cumpliéndose: si
todo lleva sitio, la suma cuadra igual, y además cada gaveta dice la verdad sobre el
dinero que tiene dentro. Un retiro sin sitio dejaba la gaveta de la tienda diciendo
que tenía un dinero que ya no estaba.

**Un ingreso a mano sigue pudiendo no tener sitio**: un aporte de un socio puede no
entrar por ninguna tienda. La regla es para lo que **sale**.

**Los apuntes viejos sin sitio no se tocan** (#2): la fila «De la empresa» sigue
existiendo con lo de antes y sumando lo que sumaba. Al **corregir** uno de esos sí
hay que elegir caja, y eso es lo correcto — corregirlo es la ocasión de arreglarlo.

Se comprueba **en el servidor**, en una función que usan los dos caminos —apuntar y
corregir—, porque la vez que un criterio así se escribió dos veces, una de las dos
copias se quedó sin él. La pantalla, además, viene con la caja del sitio en el que se
está trabajando ya puesta: es de donde sale el dinero nueve de cada diez veces.

En `pruebas/actualizar.js` hay un retiro **sin sitio a propósito**, sembrado con el
código desplegado: es lo que comprueba que los apuntes viejos sobreviven a esto.

### Y las comisiones se pagan en Dinero, no en Ajustes

«La parte de comisiones que sale en ajustes, ¿está bien que vaya en ajustes? ¿no
debería ir en un lugar más acorde?»

No estaba bien. **Ajustes es donde se configura el negocio; pagarle a alguien es una
operación de dinero.** La pantalla estaba ahí por cómo se construyó —junto a la lista
de trabajadores, que es lo que hacía falta para calcularla—, no por dónde la buscaría
alguien que va a pagar.

Se mudó a **Dinero → Comisiones**, junto al fondo, las inversiones y los trabajos,
que es donde está el dinero del que sale. En Ajustes → Personal queda **solo lo que
sí es configuración**: quién trabaja, con qué cargo y **en qué moneda cobra**, con un
aviso de dónde se paga.

De paso, una petición menos de las doce que disparaba la pantalla de Ajustes al
abrirse.

`pruebas/pantallas.js` comprueba que el mes y la lista están **dentro** de la pantalla
de Dinero: si se hubieran quedado en Ajustes, la pestaña saldría vacía y nadie sabría
por qué. Y busca **dentro del apartado** de Ajustes, no en todo el archivo — al
escribir esa prueba, un patrón suelto encontraba la lista en Dinero y pasaba sin
comprobar nada.

---

## 38. El dinero sale de una caja de verdad, y solo si está dentro

Dos cosas pedidas por el dueño el 21 de agosto de 2026, sobre la pantalla de
inversiones:

> «En inversiones quiero quitar la opción que dice sacar dinero del fondo del
> negocio, solo quiero dejar que se pueda sacar dinero [de] los puntos que tengo:
> tienda, almacén principal y brigada. Otro detalle: no me puede retirar dinero
> del fondo si no existe el dinero, tiene que mostrarme un cartel de que no tengo
> ese dinero y prohibírmelo.»

### Se acabó «del fondo del negocio»

Es el último resto del reparto viejo. La **#22** dio una fila «Del negocio» a lo
que no era de ningún punto, para que la suma de las gavetas siguiera siendo el
saldo del fondo; la **#37** ya quitó esa opción de los retiros, los gastos y los
apuntes de inversión hechos a mano. **En la pantalla de inversiones seguía**, y
además venía puesta por defecto.

Ese «fondo del negocio» no es ninguna gaveta que se pueda ir a contar. Sacar de
ahí es sacar de un montón que no existe, y deja la caja de la tienda diciendo que
tiene un dinero que ya no está dentro.

Ahora el desplegable arranca en **«Elige…»** y solo lleva sitios de verdad. Se
comprueba **al guardar** y otra vez **al registrar**, porque un borrador de antes
del 21 de agosto puede no llevar caja. **Lo ya registrado no se toca** (#2).

**Lo que se conserva:** si la inversión va enlazada a un trabajo y no se elige
caja, sigue saliendo de la caja de ese trabajo (#19) — el cobro entero vuelve
ahí, así que es de donde tiene sentido que salga. La pantalla la propone al elegir
el trabajo, pero solo si no había ninguna puesta: el dinero puede haberlo puesto
otra tienda.

### Una gaveta en negativo no existe

Si sale, es que **falta apuntar un dinero que entró** o que alguien se equivocó de
caja. Y a partir de ahí ninguna cifra del fondo se puede creer, porque el saldo ya
no es el dinero que hay dentro. Por eso se prohíbe, y no se avisa nada más.

Va en **una sola función**, `faltaDinero()`, que usan los **cinco** caminos por los
que sale dinero: apuntar, corregir, registrar una inversión, pagar una comisión y
el pase entre cajas. El pase ya lo comprobaba por su cuenta desde el principio;
esa comprobación se sustituyó por la común en vez de dejar dos. La vez que un
criterio así se escribió dos veces, una de las copias se quedó sin él.

**Se mira por moneda.** Tener 500 USD no da para pagar 500 CUP: son dos gavetas, y
sumarlas al valor del dólar sería inventar un cambio que nadie hizo.

**Se mira el saldo de siempre**, no el del período que esté abierto en la pantalla:
el dinero de la caja no sabe de fechas.

**Sacar exactamente lo que hay sí se puede.** Dejar una caja en cero es normal;
dejarla en negativo es imposible. El margen es de una diezmilésima, porque los
saldos se guardan en coma flotante.

### Dónde se para cada cosa, y por qué ahí

| | Se para | Por qué |
|---|---|---|
| **Borrador de inversión** | solo si no dice la caja | un papel se puede preparar antes de tener el dinero |
| **Registrar la inversión** | también si el dinero no está | registrar es el momento en que el dinero sale |
| **Retiro, gasto, inversión a mano** | al apuntar | ahí sale |
| **Corregir un apunte** | dentro de la transacción, **después de anular el viejo** | corregir un retiro de 100 por uno de 150 saca 50 más, no 150 |
| **Pagar una comisión** | al pagar | |
| **Pase entre cajas** | al pasarlo | ya lo hacía |

**El caso de corregir es el que tenía trampa.** Si la comprobación se hiciera antes
de anular el apunte viejo, el importe se contaría dos veces y una corrección legítima
saldría rechazada. Y si al fallar se quedara escrita la anulación sin el apunte
bueno, **corregir habría borrado**: el apunte malo desaparecido y el bueno sin
entrar. Por eso la comprobación va dentro de la transacción y lanza, para que el
rollback se lleve también la anulación. Hay prueba de las dos cosas.

### El cartel dice el número, y qué hacer

«En Tienda hay 1 200 CUP y estás sacando 1 500 CUP» — con la cifra, para poder
arreglar el importe sin ir a buscarla. Y con la salida: **apúntalo primero como
Ingreso en esa caja, o pásalo desde otra**. Un freno que solo dice que no deja a
quien lo encuentra sin saber si la aplicación está rota.

Al que pasa dinero de una caja a otra no se le puede aconsejar que lo pase de una
caja a otra, así que el consejo es un argumento de la función y cambia según de
dónde venga.

**Y antes de llegar al cartel**, las dos pantallas enseñan debajo del desplegable
**lo que hay en la caja elegida** — como ya hacía el pase entre cajas. En la
inversión, además, avisa en rojo de cuánto falta según se van poniendo líneas. Si a
quien mira no le dejan ver el fondo, no llega ninguna gaveta y no se enseña saldo
ninguno: mejor eso que un cero que parece un saldo de verdad.

### Lo que esto cambia en el día a día

**El dinero que entra de fuera hay que apuntarlo.** Antes se podía comprar un
contenedor sin que en ninguna caja hubiera con qué; ahora, si el dueño pone dinero
suyo, o entra un préstamo, o cobra algo por fuera, eso se apunta como **Ingreso** en
la caja que corresponda **antes** de la compra. Es la cuenta correcta y es lo que
hace que la gaveta se pueda ir a contar; pero es un paso que antes no existía, y
conviene saberlo antes de la primera compra grande.

`pruebas/correcciones.js` (12 comprobaciones nuevas) y `pruebas/inversiones.js`
(10 más) cubren el freno, el cartel, el rollback de la corrección y que la misma
compra pase en cuanto se apunta el dinero.

---

## 39. Ver TODOS los sitios es un permiso; no verlos no es no ver nada

Pedido por el dueño el 21 de agosto de 2026, el mismo día que la #38:

> «En el permiso que dice mostrar todos los sitios, no solo el suyo: tengo un
> trabajador que quiero que vea el fondo de la tienda que le asigné, pero con los
> permisos para esa tienda no ve el fondo; y cuando le marco "ver todos los
> sitios, no solo el suyo" ve el fondo de toda la empresa, y yo lo que necesito es
> que vea solo el de su tienda, en la que está asignado.»

Tenía razón, y el permiso estaba haciendo lo contrario de lo que dice su nombre.

### Eran dos fallos que se tapaban el uno al otro

**Uno: la pantalla de Dinero pide dos cosas a la vez.** El fondo y el desglose por
sitio, en un `Promise.all`. El desglose exigía **«Ver TODOS los sitios»**, así que
al encargado de una tienda esa puerta le contestaba 403, el `Promise.all` se caía
entero y **la pantalla se quedaba en blanco**. No es que no viera el fondo: es que
no veía nada, y desde fuera eso es idéntico a una aplicación rota.

**Dos: ni el fondo ni el desglose filtraban nada.** El guardián de los locales
(#35) mira el sitio que viaja **en la petición**, y una petición que no nombra
ningún sitio pasa limpia. `/api/fondo` contestaba con **todas** las gavetas, todos
los apuntes y el saldo del negocio entero a cualquiera que tuviera «ver la caja».
Así que al darle «Ver TODOS los sitios» se le abría el desglose… y aparecía además
todo lo demás, que ya estaba abierto desde antes.

### Lo que se ve y lo que se toca son dos preguntas

`sitiosDe()` dice **dónde puede tocar**. Ahora hay `sitiosQueVe()`, que dice **dónde
puede mirar**: con «Ver TODOS los sitios», en todos; sin él, **en los suyos**. Y el
filtro entra en las cuatro puertas que enseñan dinero o cuentas:

| | Antes | Ahora |
|---|---|---|
| `/api/fondo` | todo, con solo «ver la caja» | sus cajas: lista, resumen, gavetas y saldo |
| `/api/negocio` | 403 sin «ver todos», y si no, todo | sus filas, y el total es la suma de ellas |
| `/api/resumen` | todo el negocio si no se pedía sitio | sus locales |
| el `saldo` que contestan las demás | el del negocio | el de sus cajas |

**El filtro entra en TODAS las consultas de una misma puerta.** Dejar una fuera
enseñaría por un lado lo que se tapa por el otro, y eso es peor que no filtrar: la
mitad de la verdad no se puede leer.

**Y el total sigue siendo la suma de las filas que se enseñan** (#22). Se filtra
antes de sumar, no después: filtrar las filas dejando el total entero daría una
tabla en la que las cuentas no cuadran y nadie sabría por qué.

**La fila «De la empresa» tampoco es suya**: su `sitio_id` es nulo, no está en su
lista, y se va con las demás.

### Dos permisos que llevaban desde el 17 sin existir

Al partir `gestionar_dinero` en cinco (#35), **dos sitios se quedaron
preguntando por él**, y desde entonces contestaban que no a todo el mundo:

- **Las gavetas de `/api/negocio`** las abría `gestionar_dinero`, así que quien no
  tuviera además `ver_ganancias` recibía **todas las cifras en blanco**. Ahora las
  abre `ver_fondo`, que es el permiso que significa eso.
- **El botón de corregir un apunte** (`se_puede_tocar`) lo mismo. Salía solo porque
  el administrador pasa por delante de todos los permisos, así que **nadie lo
  notó**: el único que lo usaba era el único al que no le afectaba.

Es la clase de fallo que deja una migración grande: no rompe nada ruidosamente,
solo apaga cosas para la gente que todavía no las estaba usando.

### La pantalla tampoco ofrece lo que va a negar

Al entrar, el servidor manda **`mis_sitios`** (null = todos), y con eso el
desplegable de arriba y el del resumen enseñan **solo sus locales**. Ofrecer un
sitio para que el servidor conteste 403 al elegirlo es prometer algo que no se va
a cumplir.

Si el sitio guardado en ese teléfono ya no es uno de los suyos —le cambiaron el
local, o el cargo—, se pasa solo al primero que sí lo sea; si no, seguiría
trabajando contra un sitio que el servidor le niega en cada petición.

**`SITIOS` se queda entero a propósito**: hace falta para poner el nombre de un
sitio ajeno cuando aparece en un traslado o en un apunte viejo. Lo que se filtra son
los desplegables, no el diccionario de nombres.

**Y la pantalla dice lo que está mirando.** Con `ver_todo` en falso, el saldo grande
no se titula «Fondo general de la empresa» y el total de la tabla no dice «TOTAL DE
LA EMPRESA». Enseñarle 40 000 bajo el rótulo «toda la empresa» sería mentirle sobre
lo que tiene delante.

**Además, el desglose ya no puede tumbar la pantalla**: se pide con su propio
`catch`. Una puerta cerrada tiene que quitar su trozo, no la pantalla entera.

`pruebas/permisos.js`, 17 comprobaciones nuevas: que el fondo se abre, que trae una
sola gaveta, que el saldo es el suyo, que no hay ni un apunte de otro sitio, que el
total cuadra con la fila, que las cifras llegan y no en blanco — y que al marcarle
«Ver TODOS los sitios» pasa a verlo todo, que es lo que ese permiso significa.

---

## 40. No se rebaja mercancía que no está

Pedido por el dueño el 22 de agosto de 2026:

> «Lo que quiero corregir es en las mermas: la aplicación no puede dar mermas que
> excedan las existencias. Si solo quedan 2 y la merma es 3 no puede ser, porque no
> existe el producto para darle merma. He visto en varios sitios que hemos tenido
> que corregir cosas similares: no se pueden rebajar dinero que no existe y no se
> pueden rebajar productos que no existen.»

Tiene razón en lo de «varios sitios», y esa es la parte importante. Es la misma
regla de la **#38** —el dinero sale de una caja de verdad y solo si está dentro— y
de la **#34** —no se cotiza lo que no está—, y las dos nacieron por separado. Esta
la cierra para la mercancía y **la deja en un solo sitio**.

### Un estante en negativo no existe

Si sale, es que **falta apuntar una entrada** o que la cantidad está mal. A partir
de ahí ninguna cifra del inventario se puede creer: ni lo que hay, ni lo que vale,
ni la ganancia, que se calcula con el costo de una mercancía que no estaba. Una
merma de 3 con 2 en el estante, además, **cuenta como pérdida un panel que nunca
existió**: el negocio se apunta un dinero perdido que no perdió.

### Va en UNA función, y por ella pasan los seis caminos

`queFalta()` decide, `faltaMercancia()` escribe el cartel, y las usan **todos** los
caminos por los que sale mercancía:

| | Se para | Nota |
|---|---|---|
| **Merma** | al apuntarla | es lo que él pidió |
| **Ajuste que resta** | al apuntarlo | contar no puede dar menos que nada |
| **Venta** | al cobrar | ya lo hacía, con su propia copia; ahora usa la común |
| **Despacho a otro punto** | antes de escribir nada | ya no lo comprobaba nadie |
| **Material de un trabajo** | al guardar y al completar | ya lo hacía (#34); ahora comparte la cuenta |
| **Cancelar una inversión** | al cancelar | mete el movimiento contrario de cada entrada |
| **Conteo del cierre** | al cerrar el día | un conteo en negativo entraría como ajuste |

La venta y los materiales **ya tenían el criterio escrito aparte**. No estaban mal;
el problema es que eran dos copias de la misma regla, y en la #38 ya se vio adónde
lleva eso: la copia que se queda sin la corrección es la que nadie mira. Ahora la
venta llama a la misma función, y con eso desapareció su cuenta a mano de «lo que
ya se apartó en esta misma venta».

**Se agrupa por sitio y producto antes de comparar.** El mismo producto puede venir
en dos líneas —dos tiradas de cable, dos renglones del mismo despacho— y mirar cada
una por separado deja pasar un total que no cabe: 20 + 20 metros con 30 en el
estante son dos líneas que caben y un envío que no.

**Cada sitio mira SU estante.** Tener 10 paneles en el almacén no da para dar de
baja 3 en la tienda: son dos estantes, igual que dos cajas no se suman aunque sean
del mismo negocio (#38).

**Sacar exactamente lo que hay sí se puede.** Dejar un estante en cero es normal;
dejarlo debiendo es imposible. El margen es de una diezmilésima, porque las
cantidades llevan decimales — el cable se vende por metros.

**El freno va antes de escribir**, y en el despacho eso importa más que en ningún
otro sitio: un traslado guardado a medias deja mercancía **en tránsito que nunca
salió**, y el punto que la recibe la apunta como si hubiera llegado. Ahí sí se
inventa mercancía de la nada.

### Lo que NO se para

**La devolución de una venta, el traslado que se cancela y el trabajo que se echa
atrás** devuelven mercancía: entran, no salen. Y **el cierre del día con su ajuste**
deja el estante exactamente en lo contado, que nunca es menos de cero.

**La venta conserva su llave.** El ajuste «vender sin stock» (#6) sigue mandando
solo en la caja, y sigue cerrado. Es el único camino con esa salida, y por una razón
que no vale para los demás: con varios aparatos sin internet, dos cajas pueden
vender la última unidad a la vez y solo se ve al juntarlas. La merma, el despacho y
el ajuste los hace una persona mirando el estante, y ahí no hay carrera que valga.

### El cartel dice la cifra, y qué hacer

«De «Panel 450W» en Tienda Centro quedan 2, y estás sacando 3. No se puede rebajar
mercancía que no está» — con el número, para poder arreglar la cantidad sin ir a
buscarla, y con la salida: **apunta primero la entrada, y si ya se vendió o se usó
en un trabajo, ya salió del inventario y no hay que darla de baja otra vez.**

Y antes de llegar al cartel, la pantalla de la merma enseña **lo que hay en ese
sitio** debajo del producto elegido, y lo pone **en rojo** en cuanto la cantidad se
pasa — como el saldo de la caja en la #38 y como los materiales de un trabajo. La
lista del despacho marca en rojo la línea que no cabe. La pantalla evita el viaje;
el que dice que no sigue siendo el servidor (#10), porque desde otro dispositivo
pueden haber vendido mientras tanto.

### Lo que esto cambia en el día a día

Igual que la #38 con el dinero: **lo que entra hay que apuntarlo**. Si llega
mercancía y nadie la registra, la aplicación no dejará darle merma ni despacharla, y
la salida no es forzarlo, es apuntar la entrada — que además era lo que había que
hacer de todas formas.

Y **una inversión cuya mercancía ya se vendió no se cancela**. Cancelarla saca del
estante lo que entró con ella, y eso ya no está. Lo que sí se puede es apuntar la
merma o la devolución de lo que quede.

`pruebas/mermas.js`, 42 comprobaciones nuevas: la merma que se pasa, que al negarse
no queda apuntada, que cada sitio mira el suyo, el estante en cero, el ajuste en los
dos sentidos, el despacho que no deja traslado en tránsito, las dos líneas que se
suman, la venta con el mismo producto repetido, el conteo en negativo, la inversión
que ya no se puede deshacer — y que el criterio siga viviendo en una sola función.

---

## 41. La tarjeta de Dinero es un estado de cuenta, y cada renglón se abre

Filtrando un día, la tarjeta de un sitio contestaba una sola cosa: qué se movió
ese día. Quedaban dos preguntas fuera, y las dos son las que se van a hacer
mirándola: **en qué queda la caja**, y **de qué está hecho cada renglón**
—«ingresos por ventas 166 USD, ¿cuáles ventas, de qué, a cómo?»—.

### Cambiar el rótulo no bastaba

La cifra grande se llamaba «saldo», que se lee como «esto es lo que tiene». No lo
era: era lo que se movió. Llamarla «entró − salió» quita el malentendido, pero
**no contesta la pregunta**. Quien mira un día atrás no quiere saber cuánto se
movió: quiere saber **con cuánto se cerró esa noche**. Un rótulo honesto que no
contesta sigue mandando a la persona a hacer la cuenta a mano, que es de donde
sale el error la primera vez.

Ahora la tarjeta enseña las tres cosas, en este orden:

```
Tenía al empezar        79 097 CUP + 439.00 USD   ← saldo la víspera del período
  Ingresos por ventas               166.00 USD    ← lo que se movió, por concepto
  Otros ingresos           130 CUP +  10.00 USD
  Retiros                         4 638 CUP
  Gastos                          1 000 CUP
  Entró menos salió       -5 508 CUP + 176.00 USD
Quedó al terminar        73 589 CUP + 615.00 USD   ← y con cuánto se cerró
```

Y el número grande de la cabecera es **lo que quedó**, no lo que se movió.

### El atajo que parece obvio es el único que no vale

Sumarle al efectivo que hay HOY lo que entró y salió un día pasado cuenta ese día
**dos veces**: el efectivo de hoy ya lo lleva dentro. Lo que se suma es el saldo de
la **víspera** (`fecha < desde`). Un número que cuadra por dentro y miente por
fuera es peor que no dar ninguno.

**No rompe la #22.** Aquella dice que lo que pasó y lo que hay son dos tablas
distintas, y sigue siendo verdad: aquí no se mete un saldo *dentro* de un
período, se ponen **los dos extremos** del período, cada uno con su rótulo y su
fecha. Y «Efectivo en caja hoy» solo aparece cuando **es distinto** de lo que
quedó; filtrando hasta hoy son la misma cifra y enseñarla dos veces seguidas solo
hace dudar de si son lo mismo.

**Se suma, no se pide aparte.** `quedó = tenía + entró − salió`, calculado en la
pantalla. Pedirle al servidor el saldo final por su cuenta podría dar otra cifra y
no habría forma de saber cuál miente — la misma regla del total de la #22.

### Cada renglón se abre, y enseña de qué está hecho

`GET /api/negocio/desglose?concepto=&sitio_id=&desde=&hasta=` devuelve los apuntes
que suman un renglón. De una **venta**, los productos con su cantidad, su precio y
su importe; de una **compra**, su número y su nombre; de un **traspaso**, con qué
caja fue.

**La condición que saca el desglose es la MISMA que suma el renglón**, escrita una
sola vez, en el mapa `DESGLOSE` de `server.js`, pegado al bucle que llena `fondo`.
Un `WHERE` parecido pero no igual daría un desglose que no suma lo que dice el
renglón de encima, y nadie sabría cuál de los dos miente. La prueba compara los
dos, concepto por concepto, en cada sitio y en el total.

**Va cerrado y se pide al abrir.** Son ocho renglones por tarjeta y varias
tarjetas: cargarlo todo de entrada son decenas de consultas para algo que casi
nadie va a abrir, y en un teléfono con la conexión de allá eso se nota. Y se pide
una sola vez: cerrar y volver a abrir no vuelve a preguntar.

**Aquí los anulados SÍ salen**, tachados. Es lo contrario que en la lista de
Movimientos, y a propósito: allí el error, la corrección y la resta estorban;
aquí el renglón de arriba cuenta los dos —suman cero— y esconderlos dejaría un
desglose que no cuadra, que es justo lo que se viene a comprobar.

**El total lo suma el servidor de la tabla entera**, no de los apuntes que manda.
La lista se corta en 300 y lo avisa; si se sumaran solo esos, un período largo
enseñaría un total más chico que el renglón de arriba.

**Y se ve lo que se puede ver** (#10 y #39). La puerta la abren tres permisos
porque la pantalla de Dinero se arma con varias cosas, pero el dinero lo abre
`ver_fondo` y nada más. Quien manda en un local pide el desglose de su local: el
de otro y el del dinero de la empresa se le niegan, y su «total» es el de sus
locales, no el del negocio.

`pruebas/desglose.js`, banco nuevo: la víspera y el cierre encadenados día a día,
que mirándolo todo lo que quedó es el efectivo que hay, los conceptos cuadrando con
su desglose en dos sitios y en el total, la venta con sus líneas y la cantidad al
derecho, el anulado que sale y suma cero, el concepto inventado que da 400, y los
tres 403 de quien solo manda en su tienda.

---

## 42. Todo apunte a mano dice en qué caja pasa el dinero, el ingreso también

El ingreso tenía un **«Ninguno en concreto»** y se quitó el 31 de agosto de 2026.
Es la **#37 vista por el otro lado**: aquella obligó a decir de qué caja SALE el
dinero, porque si no, la gaveta de ese sitio seguía diciendo que tiene un dinero
que ya no está. Con lo que ENTRA pasa lo simétrico: el dinero entra físicamente en
alguna caja, y no decir cuál deja esa gaveta sin contar un dinero que sí está
dentro. En los dos casos el efectivo apuntado deja de cuadrar con el que se puede
ir a contar, que es justo para lo que sirve.

**Ojo con no juntar las dos listas.** `SALE_DE_UNA_CAJA` es la de la #38 —la que
comprueba que el dinero ESTÉ dentro antes de sacarlo— y el ingreso **no** va ahí:
no tiene que estar dentro de nada, lo está metiendo. Juntarlas prohibiría ingresar
en una caja vacía, que es exactamente lo que hace falta para abrir una tienda
nueva. Son dos preguntas distintas y son dos cosas distintas en el código.

**Los apuntes viejos sin sitio no se tocan** (#2). La fila «De la empresa» sigue
existiendo y sumando lo que sumaba; simplemente ya no se le añade nada nuevo. Y al
**corregir** uno de esos, ahora hay que elegir caja — que es lo correcto:
corregirlo es la ocasión de arreglarlo.

**La pista de debajo cambia según por dónde va el dinero.** En lo que sale dice
«no se puede sacar más de lo que hay»; en un ingreso eso no viene a cuento —no hay
tope— y lo útil es con cuánto se queda esa caja.

`pruebas/desglose.js` comprueba que un ingreso sin caja se rechaza y **dice por
qué**, que con caja entra, que se puede ingresar en una caja vacía, y que el apunte
heredado sin sitio sigue contando. Y `pruebas/pantallas.js` comprueba las dos
listas por separado, para que nadie las junte sin darse cuenta.

**Sembrar un apunte sin sitio ya no se puede por la puerta**, así que las pruebas
que lo necesitaban lo escriben directo en la base, con un ayudante que se llama
`apunteHeredadoSinSitio` y dice en su comentario exactamente eso: es un registro
del pasado, no algo que la aplicación pueda crear hoy.

---

## 43. Lo que se fía: el dinero entra por el COBRO, no por la venta

Pedido por el dueño el **3 de septiembre de 2026**: «poder crear ventas y
enlazarlas a clientes de forma opcional; a veces el cliente obtiene la mercancía
pero queda una cuenta por pagar y la paga luego, a veces la paga de forma
completa o a veces va pagando poco a poco, y necesito saber de lo que pagué
cuánto le va faltando por pagar. Necesito que en esas ventas a clientes se pueda
ir cambiando de estados a pendiente de cobro, o ya cobrada».

### Una venta, y el dinero llega cuando llega

No hay dos clases de venta. **Una venta de mostrador es una venta con UN cobro
por su total, hecho en el mismo momento**; una fiada es la misma venta sin cobro
todavía, o con cobros más pequeños según vaya pagando. Partirlas en dos tipos
habría dejado dos caminos que hacen casi lo mismo, y el día que se cambie uno se
olvidará el otro.

**Lo cobrado no se guarda: se suma.** Es la regla del stock (#1) aplicada al
dinero. Una columna `pagado` que se va editando serían dos verdades sobre lo
mismo —la columna y la lista de cobros— y el día que no coincidan no habría forma
de saber cuál miente. Lo mismo con el **estado**: `pendiente`, `parcial` y
`cobrada` se leen de la resta, no se guardan ni se cambian a mano. Un estado
guardado acabaría diciendo «cobrada» de una venta que nadie pagó.

### El fallo que esto habría dejado todas las noches

Hasta hoy el dinero entraba en la caja **al vender**. Con lo fiado, eso habría
dejado el cuadre de la jornada esperando un efectivo que nadie ha traído: **un
descuadre falso cada noche**, en la única cifra que existe precisamente para
avisar de que falta dinero.

Así que **el efectivo del día sale de los COBROS y no de las ventas**. Son dos
cosas distintas desde hoy: lo que se fía hoy no está en la gaveta esta noche, y
lo que se cobra hoy de una venta de la semana pasada sí. En la pantalla del día
se enseñan las dos, y **lo fiado de hoy aparte**, que es exactamente la diferencia
entre lo vendido y lo cobrado.

**La ganancia, en cambio, cuenta al vender**, y no cambia. La mercancía salió del
estante: si la ganancia esperara al cobro, un mes bueno parecería malo por culpa
de un cliente lento. **Y la comisión también se gana al vender**, preguntado y
confirmado por el dueño. Tiene su riesgo y conviene decirlo en voz alta: si un
cliente no paga nunca, esa comisión ya se pagó.

### Una deuda sin cliente no se le puede cobrar a nadie

Por eso el cliente es una **ficha** y no un nombre escrito a mano en cada venta.
Escrito a mano, «Juan», «Juan P.» y «juan perez» son tres deudas de la misma
persona, y «¿cuánto me debe Juan?» deja de tener respuesta.

Y por eso **el servidor se niega a fiar sin cliente**. No avisa: se para. Una
venta fiada sin cliente es dinero que dentro de un mes está perdido y ni siquiera
se sabe de quién era. La pantalla lo dice antes, mientras se cobra, para que
nadie llegue al cartel del servidor con el cliente delante.

**Tampoco se da de baja a un cliente que debe algo.** Sería esconder una deuda en
vez de cobrarla.

### Anular devuelve lo COBRADO, no el total

Es el error que habría dejado la gaveta con menos dinero del que tiene: de una
venta fiada que nadie ha pagado **no hay nada que sacar de la caja**. Se devuelve
lo que entró, ni un peso más, y los cobros se deshacen uno por uno con su
contrario para que la venta no arrastre la deuda de algo que ya no existe.

Un cobro mal apuntado se deshace igual: con su contrario y con la fecha de **hoy**,
no con la del cobro, porque corregir hoy no puede mover el dinero de una jornada
ya cerrada (misma regla que la #31).

### Lo que se toca y lo que no

Una tabla `clientes`, una tabla `cobros`, y una columna `cliente_id` en `ventas`.
Nada más. Las dos tablas viajan en la sincronización (#11): los clientes como los
productos —gana el más reciente— y los cobros como apuntes, que nacen y no cambian.

**La migración da por cobrada entera cada venta de antes**, con **su** fecha y
**su** momento. Con la fecha del despliegue, el efectivo de todos los días
anteriores se mudaría al día del cambio y no volvería a cuadrar ni un cierre ya
cerrado. Y no apunta nada en el fondo: el ingreso de esas ventas ya está escrito
desde el día que se hicieron; lo que faltaba era el cobro que lo explica.

`pruebas/creditos.js` (nuevo, **51 comprobaciones**). Las que importan son las
que miran por el otro lado: que lo fiado **no** meta un peso en ninguna caja, que
el cuadre de la noche **no** lo espere, y que anular devuelva lo cobrado y no el
total.

---

## 44. Cajas y sacos: se escribe en bultos y se guarda en unidades

Pedido por el dueño el **3 de septiembre de 2026**: «en el almacén principal tengo
productos por cantidades en cajas o sacos, y cuando paso a otro de mis almacenes
necesito poder pasar esos productos convertidos a unidades».

### Por dentro TODO son unidades, siempre

La caja es **una forma de escribir la cantidad y de leerla**, nunca un dato
guardado. Se escribe «3 cajas» y se guardan 72 unidades; el estante se lee «240 (10
cajas)» y lo guardado son 240.

La otra forma —el almacén guardando cajas y la tienda unidades— se descartó, y no
por gusto: sería que **el mismo número significara dos cosas según dónde se mire**.
Con eso, el valor del inventario suma peras con manzanas, el mínimo de existencia
avisa cuando no toca, y un traslado de 3 tiene que decidir si saca 3 o 72. Es
exactamente la clase de dato con dos dueños que la #3 existe para no tener.

Se eligió con el dueño delante, entre las dos opciones dibujadas.

### La cuenta la hace el SERVIDOR

Va en **una sola función**, `cantidadEnUnidades()`, y por ella pasan los tres
caminos que mueven mercancía a mano: la entrada o merma del almacén, el despacho y
la recepción. La misma multiplicación escrita tres veces son tres reglas que un
día dejan de coincidir.

Y la hace el servidor, no la pantalla (#10). Si la hiciera la pantalla, un
dispositivo con el `app.js` viejo en su caché mandaría «3» queriendo decir tres
cajas y entrarían **tres unidades**: mercancía de menos, y sin que nadie lo notara
hasta contar el estante. Por eso lo que viaja es la cantidad tal como se escribió
y **en qué medida está escrita**, y no viajar la medida significa unidades, que es
lo que hacían todos los dispositivos hasta hoy.

### Un producto sin bulto puesto SE NIEGA

Si alguien escribe «3 cajas» de algo que no tiene dicho cuántas unidades trae una
caja, la aplicación **no guarda 3**: se para y dice dónde ponerlo. Dar por bueno el
número tal cual sería meter mercancía de menos por un camino silencioso.

### Cambiar el tamaño de la caja no reescribe nada

Y esta es la ventaja de que lo guardado sean unidades: corregir «una caja trae 24»
por «trae 12» **no toca ni un movimiento**, porque no hay nada que tocar. Lo único
que cambia es cómo se escriben y cómo se leen las cantidades a partir de ese
momento. Por eso también el historial se enseña **en unidades** y no en cajas: una
cifra vieja leída con el factor de hoy diría otra cosa que el día que se escribió.

### Dónde se puede escribir en bultos, y dónde no

Se puede en la **entrada y la merma** del almacén, en el **despacho** y en la
**recepción** —que es donde el dueño cuenta bultos de verdad—. **La caja de venta y
las inversiones siguen en unidades**: no se pidieron, y la caja además tiene un
precio por unidad que habría que decidir aparte.

`pruebas/bultos.js` (nuevo, **22 comprobaciones**). Las que importan son las que
miran lo que se rompería sin darse cuenta: que **no** mandar la medida siga
guardando unidades —o al desplegar esto todas las entradas se multiplicarían por
24—, que el freno de «no se rebaja lo que no está» (#40) cuente en unidades, y que
la pantalla **no** multiplique por su cuenta antes de mandar, que sería multiplicar
dos veces.

---

## 45. Los productos se crean en su apartado, y de ahí se les pone local

Pedido por el dueño el **4 de septiembre de 2026**: «que el sistema de productos
funcione como lo hace la otra aplicación: los productos se crean en su apartado
de Productos y se asignan a los almacenes», dejando **la ficha de crear un
producto tal como está**, que es la suya y tiene el bulto (#44) y la existencia
con la que nace. Y sobre los almacenes: «hay un almacén principal que es la suma
de todos los almacenes, se pueden transferir productos de un almacén a otro
cambiando de un saco a unidad o de una caja a unidad; **eso se mantiene igual**».

Hasta ese día el catálogo era **uno solo para todo el negocio** y los productos se
creaban desde el Almacén. Quien despacha en una tienda con quince productos
delante buscaba entre todos los del negocio, y la pantalla de existencias le
enseñaba en rojo cosas que nunca estuvieron allí. La campanita llegaba a avisarle
de que se había acabado algo que esa tienda no ha tenido en su vida.

### Dos pantallas, y cada una contesta una pregunta

**Productos** es el catálogo: qué productos existen, cómo son y de quién son. Ahí
se crean, se editan y se les pone local. **Almacén** es la mercancía: lo que hay,
lo que entra, lo que se merma y lo que se transfiere. Tocar una fila en cualquiera
de las dos abre la misma ficha, que sigue siendo una sola.

El botón «Nuevo producto» se fue del Almacén: crear un producto ahí y ponerle
local desde otra pantalla eran dos mitades de la misma cosa en dos sitios.

### Lo que se ve en un local, y por qué no es solo «lo que se creó aquí»

Un producto se ve en **el local que lo creó** y en **cualquier local que haya
tenido mercancía suya alguna vez**.

La segunda mitad no es un adorno, es lo que hace que la regla funcione: **el
almacén principal surte a los puntos**, así que casi todo lo que una tienda vende
se creó en el almacén. Con la regla literal —solo lo creado aquí—, la tienda
recibiría la transferencia y **no podría venderlo**: el producto no saldría en su
pantalla. Habría que crearlo otra vez a mano, y entonces habría dos productos con
el mismo nombre, dos códigos y dos existencias, que es exactamente la clase de
duplicado que esta aplicación existe para no tener.

Y se mira si ha **habido movimiento**, no si **queda existencia**. Una tienda que
vendió hasta el último saco tiene que seguir viéndolo, porque mañana le mandan
más; si desapareciera al llegar a cero, se iría de la pantalla justo el día que
hay que pedirlo.

**El almacén principal los ve todos.** Es el mirador del negocio (#22): quien está
allí lleva las cuentas de todo y necesita ver también lo que cada tienda se ha
creado por su cuenta. Y eligiendo «Todo el negocio, sumado» en el Almacén salen
todos los productos asignados, que es justo lo que se ha pedido mirar.

### «Todavía sin local» es una respuesta, no un hueco sin rellenar

El desplegable de la ficha tiene una opción más, y va la primera: **«todavía sin
local — se lo pongo después»**. Sirve para meter el catálogo de golpe: sentado con
la lista delante, decidir de quién es cada producto uno por uno es parar cada dos
minutos.

Un producto sin local **no sale en ningún local**: ni en la caja, ni en el
almacén, ni en el escáner, ni en la campanita, ni en los buscadores de un
movimiento o de una inversión. **Ni siquiera en el almacén principal**, que ve
todo lo demás: «todo el negocio, sumado» suma lo que está **asignado**, porque
ahí se cuentan existencias y un producto sin local todavía no es de nadie.

Sale en **un solo sitio**: la pantalla de Productos. Es donde se crea y desde
donde se le pone local, y si no saliera ahí no habría manera de asignarlo. Para
encontrarlos, el desplegable **«todavía sin local»** saca de golpe la lista de lo
que queda por repartir; solo lo ve quien mira el negocio entero, que es quien
puede poner locales, pero el **rótulo** de la lista lo ve todo el mundo: es lo que
explica por qué ese producto no aparece en la caja.

### Pero lo que está sirviendo en un local no se esconde nunca

Ese es el peligro de esta decisión, y por eso «suelto» no es «sin local» a secas:

> **Suelto = sin local Y sin movimientos en ningún local.**

Si a un producto que tiene treinta aguas en la tienda se le quita el local,
esconderlo dejaría esa mercancía **sin poder venderse y sin que nadie entienda por
qué**. Mientras haya movimientos suyos en un local, ese local lo sigue viendo. En
la práctica, lo que se esconde es exactamente lo que se acaba de escribir y
todavía no ha visto una caja: ni más ni menos.

### La existencia inicial va pegada al local

La ficha pregunta lo que hay al crear un producto, y eso apunta una **entrada** de
verdad (#1). Con la opción de dejarlo sin local, esa pregunta **desaparece
mientras no haya local**: la mercancía tiene que estar EN algún sitio, y un
producto que no es de nadie no tiene dónde meterla. En cuanto se elige un local la
casilla vuelve, diciendo en cuál va a entrar.

Y entra en el local **del producto**, no en el que se esté mirando: desde el
almacén principal se crean cosas que son de una tienda, y meterlas en el almacén
las dejaría contadas donde no están. Sin esto, meter el catálogo de una tanda
—que es para lo que existe «todavía sin local»— apuntaría cada existencia en el
local donde se esté parado, y el producto acabaría viéndose allí de todas formas
por sus movimientos, que es justo lo que se quería evitar.

### Dónde vive el dato

Una columna `sitio_id` en `productos` que dice **quién lo creó**, no dónde está.
**Dónde está se sigue sabiendo sumando `movimientos`, y eso no se toca** (#1). Son
dos preguntas distintas: el dueño de un producto no cambia porque se mueva una
caja de sitio.

**Los que ya existían pasan al almacén principal**, con su marca en `ajustes` para
que corra una sola vez. Es lo menos destructivo: el principal los ve todos de
todas formas, y cada tienda sigue viendo los que tiene en el estante porque tiene
movimientos suyos. Ninguna tienda pierde de vista nada al desplegar. Si la
migración corriera en cada arranque, un producto que el dueño hubiera movido a
mano a su tienda volvería al almacén solo.

### Mandar el local vacío y no mandarlo son dos cosas distintas

Es la misma trampa de la foto en el `PUT` de productos, y se resuelve igual:

| Lo que llega | Qué significa |
|---|---|
| un local | ese, después de comprobar que existe y está encendido |
| **vacío** | todavía sin local, **a propósito** |
| **no viene el campo** | un aparato que no sabe de esto: el local de quien lo crea, y si no tiene, el almacén principal |

Si se juntaran los dos últimos, un teléfono con el `app.js` viejo en su caché
dejaría sin local a cada producto que creara, sin que nadie lo hubiera pedido. Y
al revés: si «vacío» se tratara como «no viene», la opción nueva no haría nada y
el producto acabaría en el almacén principal calladamente. Al editar, **no mandar
el campo significa «déjalo donde está»**: si se aplicara siempre, guardarle el
precio desde una pantalla vieja dejaría el producto sin local y desaparecería de
su tienda sin que nadie entendiera por qué.

Un local **inventado** se rechaza con un 400, y **antes de escribir nada**: un 400
después de haber guardado el nombre y el precio deja la pantalla diciendo que no
se guardó y la base diciendo que sí.

### Duplicar es abrir otra ficha, no guardar otro producto

Se copia todo lo que se parece —categoría, unidad, bulto, costo, costo de
reposición, precio con sus excepciones por local, comisión, mínimo, local y foto—
y se quedan fuera las dos cosas que son de **ese** producto y de ningún otro:

- el **código de la aplicación**, que lo pone el servidor al crear: enseñar el del
  original mientras todavía no existe el nuevo sería mentir;
- el **código del fabricante**, que es el que viene impreso en su caja y no es el
  mismo que el del que se le parece.

El nombre llega con **«(copia)»** detrás, para que no queden dos iguales si
alguien guarda sin mirar.

**No se guarda nada hasta que se pulsa Guardar.** Duplicar no crea un producto:
abre la ficha con lo copiado dentro. Si se cierra, no ha pasado nada. La otra
forma —crear la copia en el servidor y abrirla para editarla— deja un producto
suelto cada vez que alguien se arrepiente. Y **duplicar no puede acabar editando
el original**, que es la forma de perder un producto sin enterarse: por eso la
prueba no lee el código buscando un texto, sino que **ejecuta** `abrirFicha()`
contra un formulario de mentira y comprueba qué queda escrito en cada casilla.

### Lo que NO hizo falta, y lo que NO se toca

**No hay guardián nuevo en el servidor.** Vender en la Tienda algo del almacén ya
es imposible desde la #40: no se rebaja mercancía que no está, y en la Tienda no
está. Esto es una decisión de **qué se enseña**, y por eso vive donde se enseña.
Añadir una segunda comprobación diciendo lo mismo por otro camino es como se llega
a dos reglas que un día dejan de coincidir.

**Cambiar un producto de local solo lo ve quien mira el negocio entero.** Quien
despacha en una tienda crea lo suyo y no tiene por qué decidir de quién es, ni
poder regalárselo a otro local sin querer.

**Las transferencias no se tocan**, ni el bulto, ni Dinero. Se puede seguir
mandando mercancía de un almacén a otro escribiendo en cajas o en sacos y
recibiéndola en unidades (#44), y Dinero sigue como estaba: el almacén principal
enseña el negocio entero sumado y, debajo, sitio por sitio (#22 y #24).

### Las dos recargas que hay que no olvidar

**Al cambiar de local**, el catálogo y sus categorías se repintan. Sin eso, al
cambiar de tienda se seguiría viendo la lista de la anterior hasta salir y volver
a entrar.

**Al recibir una transferencia**, se vuelve a pedir el catálogo y no solo el
almacén. Lo que acaba de llegar puede ser un producto que este local no tenía
todavía, y hasta que no se vuelve a pedir, la aplicación no sabe que ya es suyo:
se recibiría mercancía que no se puede vender.

`pruebas/locales.js` (nuevo) comprueba las dos mitades de la regla, la del mirador
y la de la ficha. Las dos que hay que mirar juntas son las que se contradicen a
medias: que un producto sin local **no sale en ningún local**, y que uno sin local
**con mercancía en la tienda sí sale en la tienda**. Si algún día una de las dos
se rompe, la otra sigue en verde y el fallo pasa desapercibido.

### Y dos palabras de la pantalla

El botón **«Despachar»** del Almacén pasa a llamarse **«Transferencia»**, y con él
todo lo que se lee al usarlo, porque el dueño llama transferencia a mandar
mercancía de un local a otro. Por dentro sigue siendo un traslado y no cambia ni
un dato.

Y la casilla **«¿Cuánto tienes ahora?»** de la ficha pasa a llamarse **«Stock»**,
que es como él la nombra y como ya se llamaba la alerta de más abajo.

---

## 46. En la pantalla no se nombran las tripas, y las rutas menos

Dicho por el dueño el **3 de septiembre de 2026**, con una foto de su teléfono
—la pantalla de entrar le pedía escribir una orden en la consola—: «por ningún
motivo pueden salir mensajes que hagan referencia a nada de consola, ni npm start
ni nada que tenga que ver con código o programación; eso me expone mi trabajo y
hace que no parezca profesional».

Y **ampliado por él mismo el 4 de septiembre**, con dos que se habían quedado:

- Ajustes → Copias de seguridad le enseñaba **la carpeta del disco** donde se
  guardan las copias.
- Ajustes → Este dispositivo tenía una tarjeta «Estado del sistema» cuya primera
  línea decía **«Servidor: en marcha»**.

Sus palabras: «eso es algo que me interesa a mí como programador y no a mi
cliente; solo informarle a él sobre lo relacionado con su negocio, nunca
mencionar nada de servidor ni nada de eso». **Vale para las dos aplicaciones.**

### La regla, en una línea

> En la pantalla solo sale lo que es **del negocio**. Lo de dentro —dónde vive un
> archivo, si un programa está arrancado, cómo se llama una pieza— no sale nunca.

No es solo cuestión de estética. Un dato así **no le sirve de nada a quien lo
lee**: no puede ir a esa carpeta, no puede arrancar nada, y si el servidor no
estuviera en marcha no estaría leyendo la pantalla. Ocupa sitio y quita
confianza.

### Qué se cambió

- La carpeta de las copias **ya no se manda** desde el servidor. Se quitó del
  mensaje y también de la respuesta: mientras viaje al aparato, cualquier día
  alguien vuelve a pintarla.
- «Estado del sistema» pasa a llamarse **«Lo que hay guardado»** y se le quitó la
  fila del servidor. Debajo siguen las cifras del negocio, que son las que
  importan: sitios, productos, movimientos y ventas.
- Donde se comparaba la versión ya no se dice «en el servidor» sino **«la más
  reciente»**, y el aviso del teléfono de que hay versión nueva ya no lleva
  números de versión dentro: quien los necesite los tiene al pie de Ajustes.
- Juntar dispositivos habla de **«otra copia de la aplicación»**, no de «otro
  servidor».

### Y una prueba que no deja que vuelva

`pruebas/pantallas.js` ya miraba las palabras de programación (npm, consola,
sqlite…). Ahora mira además las de **las tripas** —servidor, nginx, pm2— y
**cualquier ruta del disco**, tanto en los textos de `app.js` como en lo que se
lee entre etiquetas en `index.html`. Se saltan a propósito las direcciones y los
identificadores internos, donde esas palabras son parte de un nombre y están
perfectamente. Y se comprueba aparte que el servidor **no mande** la carpeta de
las copias, que es por donde entró la primera vez.

---

## 47. Cuatro cosas que la aplicación no dejaba hacer, y los avisos con su nombre

Pedidas por el dueño el **4 de septiembre de 2026**, seguidas, mientras estrenaba
la aplicación por dentro.

### Quitar a un trabajador

Hasta hoy solo se le podía **quitar el acceso**, y la lista del personal se
llenaba de gente que ya no está. Ahora su ficha tiene **«Quitar este
trabajador»**, debajo del Guardar y separado de él.

Las dos cosas siguen existiendo porque son distintas: **quitar el acceso** es
para quien se va unos meses y vuelve; **quitarlo** es para quien ya no está. El
aviso lo dice, por si se pulsa la que no era.

**Se quita en blando.** Su fila se queda con la fecha en que se quitó, porque las
ventas, los cierres y las comisiones que hizo apuntan a ella: borrarla de verdad
dejaría el historial diciendo «Sin identificar» donde antes decía su nombre, y
eso es reescribir lo que pasó (#2). Lo que se ve sí cambia: deja de salir en el
personal, en el reparto del día y en la puerta de entrada, y **sus sesiones se
cierran** —si no, el teléfono que dejó abierto seguiría dentro—.

**Dos puertas cerradas, y las dos por lo mismo:** nadie se puede quitar a sí
mismo, y no se puede quitar al **último administrador** que queda en pie. Sin eso
se puede dejar el negocio cerrado por dentro, con todos los datos dentro y nadie
que pueda entrar a arreglarlo.

Quitar un **cargo** ya se podía, y sigue igual: el servidor se niega si alguien lo
tiene puesto y dice quién. Lo que se arregló es que un trabajador ya quitado no
bloquee el cargo.

### Exportar lo que se quiera, no siempre lo mismo

«Juntar dispositivos» exportaba siempre lo del sitio en el que se estuviera
trabajando, y como en Ajustes no hay dónde cambiar de sitio, salía **siempre lo
del almacén principal**. Ahora hay un desplegable: **todo el negocio** —que es lo
que contesta a «quiero una copia de todo»— o **un local suelto**, para mandarle a
un dispositivo solo lo suyo.

El servidor ya sabía hacer las dos cosas desde el primer día; lo que faltaba era
dónde pedirlo.

### Los avisos, con el nombre de esta aplicación

El aviso del teléfono decía **«Hay 3 cosas nuevas»**, y el de la versión nueva
soltaba dos números de versión en la barra del teléfono. Ni una cosa ni la otra
le dicen nada a quien los lee de refilón.

Ahora: **«3 avisos que atender»** con los títulos debajo; el de la versión dice
**«Hay una versión nueva de D´Padrones»** y explica qué pasa al tocarlo, sin
números —quien los necesite los tiene al pie de Ajustes y en la tarjeta de la
Caja—; y el aviso de prueba, al dar permiso, dice **«Avisos activados»** en vez de
«Listo», que en la barra del teléfono no se sabía de qué era.

El texto de cuando están bloqueados hablaba del **candado de la barra de
direcciones**, que en una aplicación instalada en el teléfono no existe. Ahora
manda a los ajustes de notificaciones del teléfono, que es donde se arregla de
verdad.

### Y un local se puede arreglar, no solo crear

Añadido el **4 de septiembre de 2026**, al ver su instalación de verdad: tenía un
local llamado «Almacén» que le había quedado como **punto de venta**, y la
aplicación solo dejaba **crear**. Un nombre o un tipo mal puestos se quedaban para
siempre, y crear otro al lado no arregla nada: deja dos.

Ahora se toca cualquiera de la lista de Ajustes → El negocio y se le cambia el
**nombre**, **lo que es** y **de qué almacén se surte**.

**Tres frenos, y los tres por la misma razón** —que un cambio no deje colgando algo
que ya existe—:

- Un **almacén que surte a alguien** no puede pasar a punto de venta: quien se
  surtía de él se quedaría colgando de un sitio que ya no reparte. Se dice a quién
  surte, para poder arreglarlo primero.
- Un local **no se surte de sí mismo**, ni del **mirador**, que no reparte nada.
- Un **almacén no se surte de otro almacén**: la cadena de dos saltos no la sabe
  leer nadie, así que ese desplegable ni se enseña cuando se elige «Almacén».

**Al mirador solo se le cambia el nombre** (#48). No tiene tipo que elegir, no se
surte de nadie, no se puede apagar y no se puede quitar: sin él no habría dónde ver
los totales.

**Quitar un local solo se puede si no lo usa nada.** Aquí no vale el borrado suave
de los productos: un local no aparece en el historial por su nombre, sino porque
media docena de tablas lo apuntan, y quitarlo con algo dentro dejaría ventas y
jornadas colgando de un sitio que no existe. Se miran las catorce cosas que pueden
nombrarlo —movimientos, ventas, cobros, jornadas, conteos, dinero, inversiones,
repartos, traslados de ida y de vuelta, precios especiales, productos, personas y
los locales que se surten de él—.

**Y cuando no se puede, se dice QUÉ lo está usando y se ofrece la salida de
verdad: apagarlo.** Un local apagado deja de salir en todas las listas y lo que ya
pasó se queda como está. «No se puede» a secas manda a buscar a ciegas por seis
pantallas.


### Y «la gente» pasa a ser «el personal»

El apartado de Ajustes ya se llamaba Personal en el índice y **«La gente»** al
entrar. Se unifica en **Personal**, y con él las líneas que decían «Queda después
de la gente» y «Esto es dinero para la gente». Es la misma idea escrita como se
escribe en una oficina.

---

## 48. El Almacén Principal no es un sitio: es el mirador

Dicho por el dueño el **4 de septiembre de 2026**, unas horas después de desplegar
la #45: «dije que en D´Padrones **el almacén principal es solo para sumar lo de
todos los almacenes, ahí no se asigna nada**; entonces por qué en Productos me sale
para asignar productos al almacén principal. Ni en dinero ni en productos se mueve
nada por el almacén principal; en el almacén principal solo se ven los totales de
todo, es para eso».

Y una precisión suya que lo cierra: **el Almacén Principal lo creó la aplicación
sola al instalarse**, no lo creó él pensando en un almacén de verdad.

### De dónde venía el error

La #45 se trajo entera de la otra aplicación, y allí el almacén principal **es un
almacén de verdad**: guarda mercancía y surte a las tiendas, además de ser el
mirador del negocio (#22). Aquí no. Aquí el negocio son sus locales, y el «Almacén
Principal» es el sitio que la aplicación siembra al instalarse para poder ponerse
en él y ver **la suma de todos**.

Copiar una decisión de otra aplicación es copiar también las suyas, y esta venía
pegada sin que se notara: en la pantalla de Productos, el desplegable «Este
producto es de» ofrecía el Almacén Principal como si fuera un local más. Y peor:
**la migración de la #45 le dio todos los productos que ya existían.**

### La regla

> El mirador es **desde donde se mira**, no **dónde están las cosas**. Ahí no se
> asigna un producto, no entra ni sale mercancía, no se vende, no se cierra un día
> y no pasa dinero.

Sigue estando en el desplegable de arriba —el de «dónde estoy»—, porque es
justamente para lo que existe: ponerse ahí y ver los totales. Desaparece de todos
los demás, que son los de «dónde pasa esto»: de qué local es un producto, a dónde
se transfiere, de qué caja sale el dinero, en qué local trabaja alguien, de qué
almacén se surte una tienda, qué se exporta.

### Se reconoce por su identificador, no por ser el más viejo

La #45 decía «el almacén principal es el primer almacén que se creó». Esa regla
tiene una trampa que no se ve hasta el día que pasa: **si alguien apaga ese sitio,
el mirador pasa a ser el siguiente almacén** —uno de verdad, con mercancía dentro—
y de golpe deja de poder guardar nada, sin que nadie entienda por qué.

Ahora es el sitio que la aplicación siembra al instalarse, y se conoce por su
identificador. Está escrito en **una sola línea en cada lado** —`MIRADOR` en el
servidor y en la pantalla—, porque si cada lado eligiera uno distinto, la
aplicación enseñaría una cosa y el servidor guardaría otra.

### Lo niega el SERVIDOR, no la pantalla

Esconder las opciones es decoración (#10): un teléfono con el `app.js` viejo en su
caché sigue ofreciendo el mirador en cada desplegable, y colaría. Hay **un guardián
en el servidor**, delante de todos los demás, que mira las escrituras y las rechaza
si llevan el mirador puesto —arriba del cuerpo o **dentro de una línea**, que es la
puerta de atrás de las inversiones—.

Las lecturas no se tocan: un `GET` con el mirador puesto es alguien **mirando**,
que es justo para lo que está.

### Lo que arrastra

**La migración se deshace con otra migración.** Los productos que la #45 dio al
mirador vuelven a **«todavía sin local»**, que es de donde el dueño los reparte
(#45). Corre una vez, con su marca en `ajustes`; si corriera en cada arranque, un
producto asignado a mano volvería a quedarse sin local solo.

**Lo que no se puede deshacer solo, se dice.** Si hubiera movimientos apuntados en
el mirador, esa mercancía dejaría de verse en el estante de nadie. No se tocan —un
movimiento no se edita ni se borra (#2)— y mudarlos sería inventarse a cuál. Así
que el servidor lo **avisa al arrancar**, con la cuenta.

**Lo que no se reparte de una inversión se queda en el local de la caja que pagó**,
y ya no en el almacén principal. No es una elección al azar: es el único local de
la inversión que ya está decidido y comprobado.

**Un producto que nace sin que nadie diga de quién es** —un aparato viejo que no
manda el campo— es del local de quien lo crea, y si esa persona no tiene local, se
queda **sin local**. Antes caía en el almacén principal, y allí no lo vería nadie.

### En la pantalla

En la **Caja**, estando en el mirador, se dice **«aquí no se vende»** y se apaga el
buscador y la rejilla: dejar armar un carro que el servidor va a rechazar es hacer
perder el tiempo y parecer roto.

En el **Almacén**, estando en el mirador, se enseña **siempre la suma** —el
desplegable de «solo lo que hay aquí / todo el negocio» desaparece, porque una de
las dos opciones no significa nada— y no sale ningún botón de mover mercancía.

En **Ajustes → La empresa**, la lista de sitios lo dice tal cual: «Solo para ver los
totales de todos sumados. Aquí no se guarda ni se vende nada». Sin eso, no habría
manera de entender por qué no sale en los desplegables.

### Y de qué local es cada producto, en la propia fila

Pedido el mismo día: «en Productos debe decir claramente por algún lado a dónde
está asignado el producto». Va **el primero de la línea de abajo y con el color de
la marca**, no perdido entre las categorías: es la pregunta que se le hace a esa
pantalla. El que no tiene ninguno lo dice en rojo, que es lo que hay que ir
arreglando; y si su local ya no existe, se dice también —así se entiende por qué no
sale en ninguna parte—.

`pruebas/locales.js` sube a **70 comprobaciones**: que el servidor niega las siete
formas de escribir con el mirador puesto, que **mirar sí se puede**, y las dos
mitades de la migración —que devuelve lo que el mirador se quedó, y que no vuelve a
correr—.

**Y diez bancos de pruebas usaban el mirador como su almacén de trabajo**, porque
era el sitio que venía hecho. Ahora cada uno crea su «Almacén Central». Que las
pruebas tuvieran que cambiar no es un fastidio: es la señal de que la regla nueva
se está aplicando de verdad.

---

## 49. El stock con el que empieza un producto: en sacos, y también después

Contado por el dueño el **4 de septiembre de 2026**, estrenando lo de la #48: «creé
el producto saco de harina de 100kg y **puse en stock 10 sacos**, lo asigné a
almacén, y en almacén me sale que hay **cero unidades** cuando deberían estar las
10».

Se reprodujo su camino exacto en la propia pantalla, y salieron **dos fallos
distintos**, los dos míos y los dos nacidos de la #48.

### 1. Creando desde el mirador, la casilla del stock no salía nunca más

La #48 dejó el mirador sin local propuesto: al crear un producto desde ahí, el
desplegable arranca en **«todavía sin local»**, y con él la casilla del stock
**desaparece** —correcto: no hay dónde meter la mercancía—. Pero la #45 solo
preguntaba la existencia **al crear**, así que cuando después se abría el producto
para asignarle el almacén, la casilla **ya no volvía**. No quedaba ninguna forma de
decir cuánto hay salvo ir a Almacén → Entrada, que él no tenía por qué adivinar.

**Ahora la pregunta sigue estando mientras el producto no haya tenido mercancía en
ningún local**, y lo dice: «este producto todavía no ha tenido mercancía en ningún
local». Es el mismo estreno, solo que más tarde.

**Y en cuanto tenga un solo movimiento suyo, desaparece para siempre.** Eso no es
una restricción arbitraria: escribir ahí un número cuando ya hay historial sería
pisarlo (#2). La marca es `p.sitios` —los locales donde ha habido movimiento—, que
el servidor ya calculaba para la #45.

### 2. «10» quería decir dos cosas distintas en dos pantallas

En una entrada del almacén se puede escribir **«10 sacos»** y el servidor
multiplica por cien (#44). En la casilla del stock de la ficha, no: ahí un 10 eran
diez **libras sueltas**. La misma cifra, escrita a dos dedos de distancia,
significaba cien veces menos.

Eso no es una preferencia, es un fallo: **una cantidad tiene que querer decir lo
mismo en toda la aplicación.** Ahora la casilla lleva su desplegable de medida, con
las mismas dos opciones que la entrada, y **solo sale si el producto viene en
bultos** —para los demás, ofrecer «cajas» sería ofrecer una forma de equivocarse—.

**La lista se rehace cada vez que se toca el bulto**, y no solo al abrir la ficha:
el bulto se está editando en esa MISMA pantalla, así que elegir «saco de 100» tiene
que poder cambiar al momento en qué se escribe la cantidad.

**La multiplicación la hace el servidor**, como en todos los demás caminos (#44).
La pantalla solo la **dice en voz alta antes de guardar**: «10 sacos = 1 000
libras». Sin esa línea hay que fiarse de una cuenta hecha de cabeza, que es
justamente lo que el bulto viene a quitar.

### Lo que enseña este fallo

**Una casilla que solo existe en un momento se convierte en una trampa el día que
ese momento cambia.** La #45 ató la pregunta al acto de crear; la #48 cambió qué
pasa al crear desde el mirador, y la pregunta se quedó sin momento. Ninguna de las
dos estaba mal por su cuenta.

**Y ninguna prueba lo cazó**, porque las dos decisiones estaban probadas por
separado y en verde. Lo cazó él, usándola. Por eso el banco ahora comprueba las
dos mitades juntas: que la pregunta vuelve al asignar el local, y que **no vuelve**
en cuanto hay un movimiento.

`pruebas/locales.js` sube a **95 comprobaciones**. Y de paso se arregló su
formulario de mentira, donde una casilla nacía **sin** `value` en vez de con el
valor vacío: la prueba se rompía con un error en vez de comprobar nada, que es la
peor forma de fallar.

---

## 50. El dinero también dice por qué unidad es

Traído por el dueño el **4 de septiembre de 2026**, con el caso delante: «registré
saco de harina de 100 kilos, **son 300 kilos, o sea 3 sacos**; precio de costo por
saco de 100 kilos **10 000** y precio de venta **15 000**. Hasta ahí todo bien.
Ahora mira los datos que refleja en almacén».

Lo que reflejaba:

| Lo que enseñaba | Lo que él quería decir |
|---|---|
| `300 u.` | 300 **kilos** |
| `costo 10 000 CUP` | 10 000 **por saco** |
| **Valor del inventario: 3 000 000 CUP** | 30 000 |

### Dos fallos, y los dos son de la aplicación

**1. La casilla del dinero no decía por qué unidad era.** Decía «Costo (lo que
pagaste)» y «Precio de venta», a secas. Quien compra sacos de cien kilos sabe lo
que le costó **el saco**, y eso es lo que escribe. La aplicación lo guardaba **por
kilo** y multiplicaba por trescientos. Cien veces más grande, sin que nada avisara.

Es **exactamente el mismo fallo de la #49 con la cantidad** —«10» quería decir dos
cosas—, pero en el dinero. La mitad que me dejé ese mismo día.

**2. Las existencias salían en «u.» aunque el producto se contara en kilos.** «300
u.» hace creer que son trescientas cosas: trescientos sacos, o trescientos algo. La
unidad estaba guardada en el producto y la pantalla la ignoraba.

### Cómo queda

El rótulo se escribe solo con la unidad del producto: **«Costo por kilogramo»**,
**«Precio de venta por kilogramo»**. Y debajo, cuando el producto viene en bultos,
un desplegable: **«Lo escribo por kilogramo»** / **«Lo escribo por saco (de 100)»**,
con la cuenta dicha en voz alta antes de guardar —**«10 000 CUP el saco = 100 CUP
por kilogramo»**—.

Las existencias salen con su unidad: **300 kilos**, no «300 u.». «Unidad» se sigue
enseñando como «u.», que es lo que cabe y lo que se ha leído siempre. Y el costo de
la fila del almacén lleva su unidad detrás: **«costo 100 CUP/kilogramo»**.

### Lo que se guarda no cambia: siempre por unidad

Y no es un detalle de estilo. **Por unidad es lo único que deja sumar el valor del
almacén** —donde hay productos que van en sacos, en cajas y sueltos— y sacar la
ganancia de una venta. Escribirlo por saco es una forma de teclear, nunca un dato
guardado, igual que las cajas de la #44.

**La división se hace en la pantalla, y no en el servidor como la cantidad (#44).**
Es a propósito, y la diferencia importa: la cantidad viaja con su medida al lado y
el servidor puede rehacer la cuenta; el precio viaja ya hecho, y el servidor no
tiene forma de saber si ese número venía por saco o por kilo. Guardar esa diferencia
sería un dato más que puede quedarse mal el día que alguien cambie el bulto.

**Los rótulos y los dos desplegables se rehacen cada vez que se toca el bulto o la
unidad**, porque las dos cosas se editan en esa misma ficha: elegir «saco de 100»
tiene que cambiar al momento en qué se está escribiendo el dinero.

### Y una decisión que es suya, no de la aplicación

Nada de esto contesta a la pregunta de fondo: **¿la harina se vende por kilos o por
sacos?**

- Si se vende **por sacos**, la unidad del producto **es el saco** y no hace falta
  bulto ninguno: 3 sacos son 3 unidades, el costo es 10 000 y el precio 15 000, y
  el valor del almacén son 30 000. Limpio.
- Si se vende **al kilo**, la unidad es el kilo y el saco es el bulto: eso es
  justamente para lo que existe la #44, y ahora el dinero se puede escribir por
  saco sin que la cuenta salga mal.

El bulto existe para quien **compra por sacos y vende al kilo**. Poner bulto a algo
que se compra y se vende por sacos es complicarse sin ganar nada.

### La prueba

`pruebas/locales.js` sube a **99 comprobaciones**: la cuenta del dinero se **saca
del propio `app.js` y se ejecuta**, no se lee. Una división mal puesta no se ve
mirando el código.

**Y una lección de la sonda con la que se comprobó:** buscaba el producto por el
principio del nombre, había dos que empezaban igual, y leyó el equivocado. **Dijo
que el arreglo no funcionaba cuando sí funcionaba.** Una comprobación que busca por
un nombre parecido miente igual que no comprobar nada.

---

## 51. En el almacén se vende por sacos; en la tienda, al kilo

Contado por el dueño el **4 de septiembre de 2026**, y es la regla de su negocio:
«la harina la vendo **por sacos a un precio más económico**, y **por kilos o libras
a un precio más alto pero desde la tienda**. Desde el almacén vendo por sacos, y si
transfiero a la tienda es para vender por unidad pero a otro precio».

### Lo que ya estaba

Casi todo, y conviene decirlo antes de tocar nada:

- **Un solo producto**, con la harina contada en kilos por dentro y el saco como
  bulto (#44). Dos productos —«saco» y «harina suelta»— habrían sido dos
  inventarios distintos, y transferir habría sido vender uno y comprar el otro.
- **Un precio distinto en cada local**: la ficha lo tiene desde el primer día en
  «Precio distinto en algún sitio». El almacén cobra 100 el kilo —10 000 el saco— y
  la tienda 200.
- **La transferencia** del almacén a la tienda, que se escribe en sacos y entra en
  kilos.

### Lo que faltaba: vender en bultos

La #44 dejó fuera la caja de venta **a propósito**, y lo dejó escrito: «la caja de
venta y las inversiones se quedaron en unidades (no se pidieron)». Ya están
pedidas. Para vender un saco había que teclear 100 kilos y hacer la cuenta de
cabeza.

Ahora cada línea del carro lleva **en qué se cuenta**, y debajo dice lo que se va a
cobrar: **«1 saco de 100 = 100 kilogramos»**. El precio sigue siendo por unidad
(#50), así que la línea cobra 100 × 100.

**La cuenta la hace el SERVIDOR, por la misma función que todo lo demás.** La #44
exige que la conversión viva en una sola función —entrada, merma, despacho,
recepción— y ahora la venta pasa por ella también. Cinco caminos, una regla. Si la
hiciera la pantalla, un teléfono con el código viejo mandaría «1» queriendo decir
un saco y se vendería un kilo.

### En un almacén se despacha por bultos; en una tienda, al detalle

Es lo que viene **puesto**, y sale del tipo del local: los almacenes arrancan en
sacos y los puntos de venta en unidades. Así no hay que cambiar la medida en cada
venta, que es lo que convertiría una comodidad en un estorbo.

No es una regla, es un valor por defecto: se cambia en la propia línea con un
toque, porque un almacén también puede vender suelto algún día.

### Dos cuentas que había que rehacer, y no son un detalle

**Lo que queda disponible se cuenta en UNIDADES.** El carro apartaba «lo escrito»,
así que una línea de 3 sacos apartaba tres kilos: se podían meter en el carro cien
veces más de lo que hay sin que nada avisara. Y el tope al escribir la cantidad se
comparaba igual de mal; ahora dice **«solo hay para 4 sacos»**, en la medida en la
que se está escribiendo.

**El bulto se guarda EN LA LÍNEA del carro**, no se busca en el catálogo. El carro
vive en el teléfono y sobrevive a cerrar la aplicación: si mañana alguien corrige
«el saco trae 100» por «trae 50», una venta a medio anotar cambiaría de cantidad
sola.

### Y una decisión suya que la aplicación no puede tomar

**El bulto es para quien compra por sacos y vende al kilo.** Si algo se compra y se
vende por sacos, la unidad ES el saco y no hace falta bulto ninguno: 3 sacos son 3
unidades y el precio es el del saco. Ponerle bulto es complicarse sin ganar nada.

En su caso hace falta, porque el mismo saco se vende entero en el almacén y al kilo
en la tienda.

`pruebas/bultos.js` sube a **29 comprobaciones**: que se vende «2 cajas» y del
estante salen 48, que se cobra la caja entera, que sin decir la medida se venden
unidades como siempre, que no se venden más cajas de las que hay —contando en
unidades— y que de lo que va suelto no se venden «cajas».

---

## Cuatro cosas que la aplicación da por hechas y nadie ha confirmado

Lo de aquí abajo **no se ha hablado nunca con el dueño de D´Padrones**: venía
dado de antes. La aplicación entera está construida sobre estas cuatro cosas,
así que conviene repasárselas con él antes de darlas por buenas:

- **Sin internet en los locales.** Cada aparato trabaja solo y la información se
  junta después: cuando el aparato pilla internet, cuando pasan por el almacén,
  o mandando un archivo por WhatsApp.
- **Se escanea con la cámara** del teléfono o la tableta.
- **Precio general con excepciones**: el administrador pone el precio de cada
  producto y puede fijarle otro a un punto concreto.
- **Varios aparatos por punto.** De aquí sale la decisión número 1.
