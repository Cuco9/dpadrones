# D´Padrones

Inventario, ventas y contabilidad para **D´Padrones**: un almacén principal,
los puntos de venta que se surten de él, y el dinero de la empresa.

Es una aplicación de **venta y almacén**, nada más: no hace trabajos ni
servicios, no lleva clientes ni cotizaciones, y no tiene sitio web. Viene de
[Quintero Solar](../QuinteroSolar), que sí hacía todo eso; lo que se quitó y
por qué está contado al principio de [DECISIONES.md](DECISIONES.md).

**Antes de tocar el código, lee [DECISIONES.md](DECISIONES.md).** Explica por
qué está hecho así, y casi todo viene de fallos reales que costaron un día
entero de trabajo en una aplicación anterior.

**Para ponerlo en internet, lee [DESPLIEGUE.md](DESPLIEGUE.md).**

## Qué hace

| Pantalla | Para qué |
|---|---|
| **Caja** | Vender: buscar o escanear, cobrar en CUP o USD, contar billetes |
| **Cierre** | Cuadrar y cerrar la jornada, y el resumen de cualquier período |
| **Almacén** | Lo que hay, entradas, mermas, despachos entre sitios, y **el catálogo**: crear y editar productos se hace aquí |
| **Dinero** | El fondo de cada caja (ingresos, retiros, gastos y transferencias), las inversiones y las comisiones |
| **Ajustes** | La empresa, los sitios, el personal y sus permisos, las copias y este dispositivo |

## Arrancarlo en tu PC

```bash
cd C:\Users\NovaTech\Desktop\Proyectos\DPadrones
npm install      # solo la primera vez
npm start
```

Y abrir **https://localhost:3010** en el navegador (con **s**: va con candado).

La primera vez tarda unos segundos de más: se está fabricando el **sello del
negocio**, que es lo que hace que los teléfonos se fíen de este servidor.

### Desde un teléfono o una tableta

Al arrancar, el servidor enseña la dirección que hay que escribir. En cada
aparato **nuevo**, una sola vez:

1. Escribir esa dirección **sin la «s»** (`http://192.168.…:3010`).
2. Sale una página que explica cómo instalar el sello. Seguirla.
3. Entrar ya por `https://…` y a trabajar.

Sin el sello el navegador enseña un aviso rojo, **no deja usar la cámara** para
escanear y la aplicación **no puede trabajar sin internet**. El porqué está en
[DECISIONES.md](DECISIONES.md#13).

La base de datos se crea sola en `dpadrones.db` la primera vez. No está en git
(los datos nunca van al repositorio), así que borrarla y volver a arrancar deja
el sistema en blanco.

## Cómo está montado

| Carpeta | Qué hay |
|---|---|
| `server.js` | El servidor: API y arranque |
| `certificados.js` | El candado: fabrica el sello del negocio |
| `db/esquema.sql` | Todas las tablas, con el porqué de cada una |
| `public/` | La aplicación que se ve en el teléfono |
| `public/sw.js` | Hace que funcione sin internet. **Sube `CACHE` en cada cambio** |
| `pruebas/` | `npm run probar` — 625 comprobaciones |
| `certs/` | El sello y su clave. **Nunca va a git**, y conviene tener copia |

Las variables de entorno llevan el prefijo `DP_`: `DP_DB` (dónde vive la base),
`DP_HTTP=1` (arrancar sin candado), `DP_TRAS_PROXY=1` (detrás de nginx),
`DP_HOST`, `DP_SALVAS`, `DP_SALVAS_CADA`, `DP_SALVAS_GUARDAR`.

## La idea en tres frases

1. El stock **no se guarda**, se suma desde la tabla `movimientos`.
2. Los movimientos **no se editan ni se borran**: anular es meter el contrario.
3. Cada dato tiene **un solo dueño**, así juntar dos aparatos es sumar y no
   hay que decidir quién gana.

## Lo que queda pendiente

- **El logo y los iconos.** `public/img/` sigue teniendo los de Quintero Solar.
  El logo de la cabecera y de los PDF se cambia desde **Ajustes → La empresa**
  sin tocar código; los iconos de la aplicación instalada (`icono-192.png`,
  `icono-512.png`, `icono-maskable-512.png`, `apple-touch-icon.png`) hay que
  sustituirlos a mano por los de D´Padrones.
- **El dominio.** Todavía sin decidir. `quinterosolar.org` **no vale**: está en
  producción y es de otro cliente.
- **Repasar con el dueño** las cuatro cosas que se heredaron de Quintero Solar
  y están al final de [DECISIONES.md](DECISIONES.md).
