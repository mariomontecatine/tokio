<div align="center">

# tokio

**Deja el prompt para luego. Vigila tu cuota. Deja de vigilar el reloj del reset.**

Te quedaste sin tokens con una cosa pequeña sin probar. Apúntala aquí y vete —
`tokio` la ejecuta en cuanto tu ventana se reinicia.

[![Licencia: GPL v3](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.5-5FA04E.svg)](https://nodejs.org)
[![Estado](https://img.shields.io/badge/estado-alpha-f0b429.svg)](#hoja-de-ruta)

[English](README.md)

</div>

---

## El problema

A los agentes de código por suscripción no se les acaba el dinero, se les acaba la *ventana*.
Llegas al límite a las seis con un test sin correr, un rename a medias y un "¿esto compila?" sin
responder. El trabajo dura cinco minutos. La espera, tres horas. Así que o te quedas ahí
actualizando, o vuelves mañana sin acordarte de qué estabas haciendo.

Y mientras tanto nada te dice qué te queda en términos con los que puedas decidir. Un porcentaje
no es un plan. La pregunta de verdad es "¿me da para una refactorización más antes de cenar?", y
eso no lo responde nadie.

`tokio` hace las dos cosas:

- **Una cola que se dispara al resetear.** Deja prompts apuntados. Se ejecutan en tu máquina, en
  tu repo, en cuanto vuelve la cuota — retomando la sesión exacta en la que estabas, si quieres.
- **Un medidor con los números reales.** No una reconstrucción: `tokio` le pregunta a `/usage` del
  propio Claude Code por el porcentaje y la hora de reset de verdad, y añade lo que solo él puede
  calcular — tu ritmo de quemado y lo que va a costar una petición antes de lanzarla.
- **La cuenta de lo que vale el plan.** Todas las respuestas que has tenido, a precio de lista de
  la API, contra lo que pagas de verdad. A casi todo el mundo le sorprende.

## Empezar

```bash
git clone https://github.com/mariomontecatine/tokio
cd tokio
npm install && npm run build
npm link              # deja `tokio` en el PATH

tokio status          # lee tu cuota ya, sin configurar nada
tokio start           # daemon + panel en http://127.0.0.1:4646
```

No hay nada que configurar ni cuenta que crear. `tokio` lee los transcripts que Claude Code ya
escribe en `~/.claude/projects/`, así que tu historial entero está ahí desde la primera ejecución.

Y cuando choques con el muro:

```bash
tokio add "corre los tests de integración y arregla lo que falle" --resume last
```

```
  resuming "Refactor del adaptador de pagos"

  Queued 79ed7209: corre los tests de integración y arregla lo que falle
  Estimate  $1.80 (up to $10.15)  — 167 past opus turns
  Leaves    ~87% of the 5h window
  Runs      when the window resets (11:00 PM)
  Safety    edits
```

Cierra el portátil.

## Lo que ves

```
  Plan: Max 5×  (estimated cap — run "tokio calibrate <pct>")

  5h window  █████░░░░░░░░░░░░░░░░░░░  21%   $26.69 of $125.00
             resets at 11:00 PM
  Week       ██░░░░░░░░░░░░░░░░░░░░░░   8%   $84.92 of $1000.00
  Week Opus  ████████░░░░░░░░░░░░░░░░  34%   $84.75 of $250.00

  Burning $50.63/h — window runs dry around 10:53 PM
  Worth $1013.15 at API prices for $100.00 paid — 10.1× your subscription

  Queue (2):
    972dab44  queued    ~$1.80  comprueba que los tests de meter pasan y arreg
    79ed7209  queued    ~$0.90  prueba rapida
```

El panel dibuja lo mismo como un solo gráfico: la ventana como una tira de registro, donde la
traza rellena es lo gastado, la línea punteada es dónde te deja tu ritmo actual, y los bloques
pasada la línea del reset son los trabajos esperando a la siguiente ventana.

## ¿Te está saliendo a cuenta la suscripción?

```
$ tokio value

  Since 1/8/2026 (your oldest transcript)

  Run on the API this would have cost      $1013.15
  Subscription over the same period         $100.00  (1 month)
  So the plan is paying back                   10.1×

  Last 7 days   $97.46
  Last 5 hours  $46.92
```

Cada respuesta que has recibido está en los transcripts, y cada una tiene un precio. Sumándolas
sale lo que te habría costado el mismo mes con una clave de API de pago por uso.

Dos matices honestos, que el propio comando imprime:

- Cuenta **los transcripts de esta máquina**. Lo que hicieras en otro portátil, o en la app de
  Claude, no está ahí: el número es un suelo, no un total.
- Es **precio de lista de la API**, es decir, lo que habrías pagado *tú*. No es lo que le cuesta
  a Anthropic servirte; su coste de inferencia es suyo y bastante menor.

Si te suscribiste antes de tu transcript más antiguo, díselo para que cuadren los meses:

```json
{ "subscriptionStartedAt": "2026-05-14", "planPriceUsd": 100 }
```

## Cómo funciona

```
  ~/.claude/projects/**/*.jsonl          Claude Code ya los escribe
              │
              ▼
     ┌─────────────────┐
     │  ingesta        │  lee cada transcript, deduplica las copias del
     │                 │  streaming y agrupa las llamadas por turno
     └────────┬────────┘
              ▼
     ┌─────────────────┐    ┌──────────────────┐
     │  medidor        │◄───│  claude -p       │  el porcentaje y el reset
     │  5 h + semanal  │    │  "/usage"        │  reales, gratis de sondear
     └────────┬────────┘    └──────────────────┘
              │
              ▼
     ┌─────────────────┐    ┌──────────────────┐
     │  planificador   │───►│  claude -p       │  en tu repo, en tu máquina,
     │  reserva mínima │    │  --resume …      │  con tu entorno levantado
     └────────┬────────┘    └────────┬─────────┘
              │                      │
              ▼                      ▼
        panel + CLI            el coste real alimenta
                               la siguiente estimación
```

Tres detalles hacen que los números signifiquen algo:

**Deduplicación.** Claude Code escribe la misma respuesta más de una vez en el transcript
mientras va llegando: en los transcripts de mi máquina hay 1,93 líneas por cada respuesta real, y
algunas aparecen tres veces. Contar líneas casi duplica el consumo aparente. `tokio` usa
`messageId` + `requestId`, así que cada respuesta cuenta una vez.

**El coste como unidad.** Los tokens no son comparables entre modelos: un turno de Opus vacía el
plan unas cinco veces más rápido que uno de Sonnet, y una lectura de caché es una décima parte de
un token de entrada. Todo se convierte a una unidad equivalente en dólares con el precio público
de la API, que es a lo que escalan de verdad los límites de la suscripción.

**Historial por turno.** Las llamadas se agrupan por el prompt que las provocó, así que la
estimación responde a "cuánto cuesta una petición como esta" y no a "cuánto cuesta una sesión
entera". Funciona desde el primer arranque, porque tus transcripts ya son los datos.

## Sobre esos límites

Anthropic no publica el tamaño de la ventana de cada plan, así que **los topes que vienen en
[`src/plans/profiles.json`](src/plans/profiles.json) son estimaciones**. `tokio` lo dice en todos
los sitios donde enseña uno, y nunca disfraza una suposición de medición.

El dato de 5 h del Max 5× al menos está medido: una cuenta real leyó un 44% en `/usage` contra
$35,99 de gasto contado, lo que deja esa ventana en unos $82. Pro y Max 20× son ese número
escalado por precio, y todas las cifras semanales siguen siendo suposiciones.

Arreglarlo cuesta diez segundos. Ejecuta `/usage` dentro de Claude Code, mira el porcentaje y
díselo:

```bash
tokio calibrate 63
```

```
  Counted $78.75 in this block window, which you say is 63%.
  So your block cap is about $125.00. Saved.
```

La ventana semanal se calibra aparte:

```bash
tokio calibrate 15 --window week
```

Con una lectura por ventana basta; con varias aguanta mejor el redondeo de ese porcentaje. Además, cualquier
límite con el que `tokio` choque de verdad queda registrado como cota inferior y sube la
estimación. La cabecera te dice en todo momento cuál de las dos cosas estás viendo.

## Seguridad

Los trabajos en cola se ejecutan sin ti delante. Esa es la gracia y también el riesgo, así que la
correa la eliges tú en cada trabajo:

| Modo | Opción | Qué puede hacer |
|---|---|---|
| `plan` | `--safety plan` | Lee y propone. No toca nada. |
| `edits` | `--safety edits` | Edita ficheros y ejecuta herramientas sin preguntar. **Por defecto.** |
| `full` | `--safety full` | Sin restricciones, dentro de ese directorio. |

Dos costumbres que compensan: encola el trabajo desatendido sobre una rama que no te importe
rebobinar, y reserva `plan` para lo que no tengas pensado del todo. `tokio` nunca amplía los
permisos de un trabajo por su cuenta, y un trabajo solo toca el directorio que le diste.

El planificador guarda además una **reserva** (10% por defecto). Un trabajo no arranca si su
estimación pesimista se comería ese suelo, para que una cola desatendida no te vacíe en silencio
la ventana que estabas guardando. Con `--urgent` se salta la regla.

## Órdenes

| Orden | Qué hace |
|---|---|
| `tokio status` | Cuota, ritmo de quemado, agotamiento previsto y cola |
| `tokio refresh` | Vuelve a leer los números reales de Claude Code y los muestra |
| `tokio value` | Lo que ha valido la suscripción, mes a mes |
| `tokio start` | Daemon, planificador y panel |
| `tokio add <prompt>` | Encola un prompt |
| `tokio ls [--all]` | Lista los trabajos |
| `tokio show <id>` | Un trabajo y su salida |
| `tokio run <id>` | Ejecuta uno ya, en primer plano |
| `tokio rm <id>` | Quita un trabajo |
| `tokio calibrate <pct>` | Le enseña tu límite real |
| `tokio sessions` | Sesiones que puedes retomar en este directorio |
| `tokio config` | Muestra el fichero de configuración |

Opciones de `add`:

| Opción | Por defecto | |
|---|---|---|
| `--cwd <dir>` | directorio actual | En qué proyecto se ejecuta |
| `--resume <id\|last>` | sesión nueva | Continúa una conversación existente |
| `--model <nombre>` | el de tu Claude Code | `opus`, `sonnet`, `haiku` o un id completo |
| `--safety <modo>` | `edits` | Ver la tabla de arriba |
| `--when <política>` | `on-reset` | `on-reset`, `asap`, `manual` o una hora ISO |
| `--urgent` | apagado | Permite gastar de la reserva |

## Configuración

`~/.config/tokio/config.json`, se crea solo. Las que importan:

| Clave | Por defecto | |
|---|---|---|
| `plan` | `max5` | `pro`, `max5`, `max20`, `custom` |
| `subscriptionStartedAt` | `null` | `"2026-05-14"` — desde cuándo pagas, para `tokio value` |
| `planPriceUsd` | `null` | Cambia el precio mensual (precio regional, asiento de equipo) |
| `reservePct` | `10` | Cuánto de la ventana te guardas |
| `usagePollMs` | `180000` | Cada cuánto releer los porcentajes reales |
| `usageMaxAgeMs` | `900000` | A partir de aquí la lectura caduca y se vuelve a estimar |
| `defaultSafety` | `edits` | Correa de los trabajos nuevos |
| `weeklyAnchor` | `null` | `{ "weekday": 3, "hour": 11 }` — al ponerlo, el medidor semanal muestra un reset real en vez de una ventana rodante |
| `concurrency` | `1` | Trabajos a la vez |
| `notify` | — | Tema de ntfy, bot de Telegram, webhook, escritorio |
| `host` / `port` | `127.0.0.1:4646` | Fuera de loopback se genera un `token` si no tienes |
| `token` | `null` | Necesario para acceso no local; va en cabecera o como `?token=` |

### Mantenerlo en marcha

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/tokio.service <<'EOF'
[Unit]
Description=tokio
[Service]
ExecStart=%h/.local/bin/tokio start
Restart=on-failure
[Install]
WantedBy=default.target
EOF
systemctl --user enable --now tokio
```

## Preguntas

**¿Funciona con ChatGPT?**
Con la suscripción ChatGPT Plus/Pro no: no tiene API, y manejar la web con un robot de navegador
incumpliría los términos de OpenAI y se rompería con cada rediseño. `tokio` no va a hacer eso.
Las claves de API de pago y el propio Codex CLI de OpenAI son otra cosa y están en la hoja de ruta.

**¿Esto va contra los términos de Anthropic?**
No. `tokio` lee ficheros de log de tu propio disco y ejecuta el CLI oficial igual que lo harías
tú, a ritmo normal. No comparte cuentas, no esquiva límites ni oculta tráfico: cuando el límite
dice basta, los trabajos esperan. Es un planificador, no un truco.

**Ya veo mis sesiones en la app de Claude. ¿Para qué quiero esto?**
La app retoma muy bien una conversación desde el móvil, pero solo mientras te quede cuota. No
guarda un prompt hasta que resetee tu límite, no te dice lo que va a costar una petición, y una
sesión en la nube no es tu máquina, con tu base de datos levantada y tus servicios corriendo.
Ese es el hueco que cubre esto.

**¿Cómo de buenos son los números?**
Los porcentajes y las horas de reset son los de Anthropic, así que son exactos a fecha de la
última lectura — el panel enseña su antigüedad y la refresca cuando quieras. Las *previsiones de
coste* sí son rangos, no promesas. El panel te enseña con qué frecuencia la realidad cayó dentro del rango
que predijo, para que lo juzgues tú. En la práctica se ajusta rápido, porque cada trabajo
terminado alimenta la siguiente estimación.

**¿El número de rentabilidad es lo que le cuesto a Anthropic?**
No, y leerlo así sería un error. Es lo que habrías pagado *tú* a precio de lista de la API por el
mismo trabajo: la alternativa que no compraste. Lo que le cuesta a Anthropic servirte es menor y
no es público.

**¿Dónde están mis datos?**
En `~/.local/share/tokio/tokio.db`, en tu máquina. No se envía nada a ninguna parte. El panel
escucha solo en loopback salvo que lo cambies a propósito.

## Hoja de ruta

- [x] Medidor con ventanas de 5 h y semanal
- [x] Cola que se dispara al resetear, con reserva protegida
- [x] Estimación de coste con bucle de realimentación
- [x] Porcentajes y resets reales leídos del propio `/usage` de Claude Code
- [ ] Proveedores de pago por token (API de Anthropic, compatibles con OpenAI, Ollama) por la
      interfaz [`Provider`](src/providers/types.ts) que ya existe
- [ ] Codex CLI de OpenAI, para quien tenga la suscripción de ese lado
- [ ] Trabajos encadenados — "si este pasa, lanza el siguiente"

## Desarrollo

```bash
npm test          # 40 tests, sin gastar tokens: el ejecutor corre contra un CLI falso
npm run dev       # daemon desde el código, sin compilar
npm run dev:web   # panel con recarga en caliente
```

Node ≥ 22.5 (por `node:sqlite` integrado). El servidor se ejecuta con el borrado de tipos de
Node, así que evita TypeScript que necesite generar código: nada de enums, propiedades de
parámetro ni decoradores.

Se agradecen contribuciones, sobre todo adaptadores de proveedores y datos reales de calibración.

## Licencia

GPL-3.0-or-later. Ver [LICENSE](LICENSE).

---

<sub>Sin relación con Anthropic ni OpenAI. Los límites de plan son estimaciones hasta que los
calibres. El nombre es un juego con token e I/O; el runtime de Rust llegó antes y no tiene nada
que ver.</sub>
