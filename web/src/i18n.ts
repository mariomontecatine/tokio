import { useCallback, useEffect, useState } from 'react';

/**
 * Two languages, no library.
 *
 * The dictionary is small enough that a build-time i18n framework would weigh
 * more than the strings it carries. Keys read as English sentences so a missing
 * translation degrades into something legible rather than into `queue.empty.1`.
 */
export type Lang = 'es' | 'en';

type Dict = Record<string, string>;

const en: Dict = {

  'verdict.idle.turns': 'Nothing running. Room for {count} more prompts like yours.',
  'verdict.idle.none': "Nothing running, and no room for another prompt until this window resets.",
  'verdict.idle.pct': 'Nothing running. {pct} of this window is still free.',
  'verdict.clear': 'You reach the reset with room to spare.',
  'verdict.clear.detail': 'At this pace you end the window at {pct}.',
  'verdict.tight': "It'll be close.",
  'verdict.tight.detail': 'At this pace you end the window at {pct}.',
  'verdict.spent': 'This window is spent.',
  'verdict.spent.detail': 'Nothing more runs until it resets at {time}.',
  'verdict.dry': 'You run out at {time}.',
  'verdict.dry.detail': "That's {until} before the window resets.",

  'ring.session': 'session',
  'ring.week': 'week',
  'ring.resets.in': 'resets in {until}',
  'ring.resets.at': 'resets {time}',
  'ring.rolling': 'rolling 7 days',

  'pace.title': 'pace',
  'pace.window': '{n}-hour window',
  'pace.reset': 'resets {time}',
  'pace.idle': 'No activity in this window yet.',

  'queue.title': 'queue',
  'queue.waiting': '{n} waiting',
  'queue.none': 'Nothing waiting',
  'queue.empty': 'Run out mid-thought? Leave the prompt here. It runs itself when your window resets.',
  'queue.runNow': 'Run now',
  'queue.remove': 'Remove',
  'queue.edit': 'Edit',
  'queue.edit.save': 'Save',
  'queue.edit.saving': 'Saving…',
  'queue.edit.cancel': 'Cancel',
  'queue.edit.safety': 'Permissions',
  'queue.edit.when': 'When to run',
  'queue.showFinished': 'Show finished',
  'queue.hideFinished': 'Hide finished',
  'queue.spent': 'spent',
  'queue.upTo': 'up to {amount}',

  'compose.placeholder': 'The one thing you never got to…',
  'compose.pasted': 'Pasted text',
  'compose.pasted.lines': '{n} lines',
  'compose.pasted.chars': '{n} characters',
  'compose.pasted.remove': 'Remove',
  'compose.pasted.expand': 'Show',
  'compose.pasted.collapse': 'Hide',
  'compose.submit': 'Queue it',
  'compose.submitting': 'Queueing…',
  'compose.options': 'Options',
  'compose.hideOptions': 'Hide options',
  'compose.newSession': 'New session',
  'compose.continue': 'Continue: {title}',
  'compose.defaultModel': 'Default model',
  'compose.forecast': 'About {p50}, up to {p90}. Leaves you at {after} of this window.',
  'compose.forecastTight': "About {p50}, up to {p90}. That doesn't fit in what's left.",
  'compose.safety.plan': 'Plan only',
  'compose.safety.edits': 'Edit files',
  'compose.safety.full': 'No restrictions',
  'compose.safety.plan.help': 'Reads and proposes. Changes nothing.',
  'compose.safety.edits.help': 'Edits files and runs tools without asking.',
  'compose.safety.full.help': 'No restrictions at all, in that folder. It runs while you are away.',
  'compose.when.onReset': 'When the window resets',
  'compose.when.asap': 'As soon as it fits',
  'compose.when.manual': 'Only when I say',
  'compose.when.at': 'At a time I choose',
  'compose.when.at.help': 'It waits for that moment, then for the window to have room.',
  'compose.when.at.past': 'Pick a time that has not already passed.',

  'worth.title': 'payback',
  'worth.line': '{used} of API usage against {paid} of subscription over 30 days ({rate}/month is {daily}/day).',
  'worth.total': 'all time',
  'worth.total.title': '{used} against {paid}, over {days} days since {since}',
  'worth.thisWeek': '{amount} this week',
  'worth.unknown': 'Not enough history yet to say.',
  'worth.today': 'today',
  'worth.yesterday': 'yesterday',
  'worth.week': '7 days',
  'worth.month': '30 days',
  'worth.period.none': 'nothing yet',
  'heat.title': 'The last 30 days, a day to a square',
  'heat.less': 'less',
  'heat.more': 'more',
  'heat.basis': 'a day of the plan costs {amount}',
  'heat.none': '{when}: nothing run',
  'heat.day': '{when} · {multiple}× the day\u2019s fee · {amount}',

  'details.show': 'Details',
  'details.hide': 'Close',

  'refresh.label': 'Refresh — ask for the numbers now',
  'refresh.failed': 'Could not read them: {error}',

  'reach.title': 'What these numbers can see',
  'reach.gauges': 'The Claude rings come from Anthropic, through Claude Code, and cover your whole account — every device, and the browser too.',
  'reach.priced.local': 'Everything with a price on it — payback, burn rate, the heatmap — is rebuilt from transcripts on this machine. Work done on claude.ai or on another computer leaves none, so it is missing from those figures and cannot be recovered.',
  'reach.claude.path': 'Claude Code found on this system.',
  'reach.claude.shim': 'Claude Code found on this system, run through a command processor.',
  'reach.claude.wsl': 'Claude Code found inside WSL, at {bin}.',
  'reach.claude.configured': 'Claude Code set by hand, at {bin}.',
  'reach.claude.unknown': 'Claude Code was not found. Without it the rings cannot be read at all — set claudeBin in the config.',
  'reach.transcripts': 'Reading transcripts from {dir} — {count} projects.',
  'reach.transcripts.none': 'No transcripts found at {dir}. Nothing priced can be worked out until there are some.',
  'reach.transcripts.remote': 'They are read across the WSL boundary, which is slow: running tokio inside WSL and pointing this window at it is faster.',
  'reach.transcripts.both': 'Both are read and merged: a machine with Claude Code installed twice writes to both, and reading one would drop the other half of the spend.',
  'reach.plan.detected': 'Plan read from your Claude account: {plan}.',
  'reach.plan.configured': 'Plan set by hand: {plan}.',
  'reach.plan.unknown': 'Your plan could not be established, so no price is put on anything. The rings never needed it; only the payback does.',
  'reach.dismiss': 'Got it',

  'detail.source': 'Source',
  'detail.source.reported': 'Reported by Claude Code',
  'detail.source.estimated': 'Estimated here',
  'detail.readAge': 'read {age} ago',
  'detail.reread': 'Read again',
  'detail.rereading': 'Reading…',
  'detail.reserve': 'Reserve kept free',
  'detail.reserve.help': 'Queued jobs stop before eating this, so there is always something left for you.',
  'detail.accuracy': 'Forecast accuracy',
  'detail.accuracy.value': '{pct} of jobs landed inside their range',
  'detail.burn': 'Burn rate',
  'detail.remaining': 'Left in this window',
  'detail.of': 'of {total}',
  'detail.plan': 'Plan',
  'detail.plan.detected': 'Read from your Claude account ({evidence})',
  'detail.plan.configured': 'Set by you, in the config file',
  'detail.plan.unknown': 'Could not be determined — set "plan" in your config, or no payback can be worked out',
  'detail.period': 'Period compared',
  'detail.period.transcript': 'Since {since}, your oldest transcript. Set subscriptionStartedAt if you were paying before that.',
  'detail.period.configured': 'Since {since}, the date you gave.',
  'detail.turnsLeft': 'Prompts that still fit',
  'detail.turnsLeft.value': '{count} — a turn of yours runs {p50} typically, {p90} when expensive, over your last {n}',
  'detail.opus': 'Opus this week',
  'detail.reconciliation': 'Checked against Claude Code',
  'detail.reconciliation.value': '{ours} here against {theirs} there, on {n} session(s) it reported.',
  'detail.prices': 'Prices are per model, at API list rates.',
  'detail.month': 'By month',

  'calibrate.title': 'These limits are a guess',
  'calibrate.help': "Anthropic doesn't publish them. Run /usage in Claude Code and type the 5-hour percentage it shows.",
  'calibrate.action': 'Save',
  'calibrate.done': 'Saved. Your 5-hour window holds about {amount}.',

  'error.daemon': 'The daemon is not answering.',
  'error.daemon.help': 'Start it with tokio, then this page picks it up.',
  'error.stale': 'reconnecting',

  'provider.claude': 'Claude',
  'provider.codex': 'Codex',

  'agents.title': 'Which AI do you use?',
  'agents.help': 'tokio meters and queues for each one you tick. What was found on this machine is already ticked, and you can change it later in Details.',
  'agents.claude': 'Claude Code',
  'agents.codex': 'Codex (OpenAI)',
  'agents.found.bin': 'found at {bin}',
  'agents.found.home': 'not on the PATH, but its history is in {home}',
  'agents.notFound': 'not found on this machine',
  'agents.none': 'Tick at least one.',
  'agents.save': 'Save',
  'agents.cancel': 'Cancel',
  'agents.change': 'Change',
  'agents.detail': 'AIs in use',

  'codex.ring.none': 'no current reading',
  'codex.ring.stale': 'read {age} ago',
  'codex.via.app-server': 'Reported by OpenAI, asked through Codex',
  'codex.via.rollout': 'Reported by OpenAI with the last Codex turn',
  'codex.via.app-server.short': 'reported by OpenAI',
  'codex.via.rollout.short': 'from the last Codex turn',
  'codex.via.none': 'No current reading from OpenAI — the window may have reset, or Codex could not be asked',
  'codex.verdict.weekFull': 'The Codex weekly window is full.',
  'codex.verdict.floor': 'The last Codex reading showed {pct} used.',
  'codex.verdict.none': 'Codex: no current reading of its window.',
  'codex.verdict.ease': 'Codex has room: {pct} of its window used.',
  'codex.verdict.tight': 'Codex is getting close: {pct} of its window used.',
  'codex.verdict.over': "Codex's window is all but spent: {pct} used.",
  'codex.verdict.limit': 'OpenAI reports the Codex limit as reached.',
  'codex.verdict.resets': 'It resets at {time}.',
  'codex.detail.source': 'Codex, source',
  'codex.detail.probe': 'Codex could not be asked',
  'codex.detail.plan': 'ChatGPT plan',
  'codex.detail.plan.value': '{plan}, as OpenAI reports it',
  'codex.detail.window': 'Codex, this window',
  'codex.detail.today': 'Codex, today',
  'codex.detail.price': 'Codex in dollars',
  'codex.detail.price.none': 'Not shown: no OpenAI price has been copied into tokio yet, so Codex is counted in tokens.',
  'codex.detail.price.value': "OpenAI's Standard API list price, read on its site on {date}, with the surcharge past 272K tokens: what it would cost on the API, not what your plan charges. It is a floor, since web searches, cache writes and the regional surcharge are not counted. Anything not run at Standard, or on a model with no price, stays in tokens.",
  'codex.usd.atLeast': 'at least {amount}',
  'codex.usd.unpriced': 'no dollar total: {n} without a price',
  'codex.tokens.value': '{input} in ({cached} cached) · {output} out, over {n} responses',
  'codex.tokens.none': 'nothing run here',

  'compose.agent': 'Agent',
  'compose.defaultModel.codex': "Codex's default model",
  'compose.codex.forecast': "No estimate: Codex reports percentages, not prices. It starts when Codex's window has room — {pct} used now.",
  'compose.codex.forecast.none': "No estimate: Codex reports percentages, not prices. It starts when Codex's window has room.",
  'queue.noEstimate': 'no estimate',
  'queue.codex.basis': 'Codex reports percentages, not prices',

  'reach.codex.gauges': 'The Codex rings come from OpenAI, through Codex itself, and cover your whole ChatGPT account.',
  'reach.codex.found': 'Codex found at {bin}.',
  'reach.codex.unknown': 'The Codex CLI was not found, so its limits can only be read from what Codex has already written, as recent as its last turn.',
  'reach.codex.threads': 'Reading Codex sessions from {home} — {count} of them.',
  'reach.codex.none': 'No Codex sessions found in {home}.',
  'reach.codex.tokens': 'Codex is counted in tokens: no OpenAI price has been copied into tokio, so nothing of Codex carries a dollar figure.',
  'reach.codex.priced': "Codex's dollars are OpenAI's Standard API list price, copied from its site on {date}: a floor on what the API would charge, not what your plan costs. The prices do not update themselves, and a model with none copied in stays in tokens.",
};

const es: Dict = {

  'verdict.idle.turns': 'Nada en marcha. Te queda para {count} peticiones más como las tuyas.',
  'verdict.idle.none': 'Nada en marcha, y no queda para otra petición hasta que se reinicie la ventana.',
  'verdict.idle.pct': 'Nada en marcha. Te queda libre el {pct} de esta ventana.',
  'verdict.clear': 'Llegas al reset de sobra.',
  'verdict.clear.detail': 'A este ritmo acabas la ventana al {pct}.',
  'verdict.tight': 'Vas justo.',
  'verdict.tight.detail': 'A este ritmo acabas la ventana al {pct}.',
  'verdict.spent': 'Esta ventana está agotada.',
  'verdict.spent.detail': 'No entra nada más hasta que se reinicie a las {time}.',
  'verdict.dry': 'Te quedas sin margen a las {time}.',
  'verdict.dry.detail': 'Eso es {until} antes de que la ventana se reinicie.',

  'ring.session': 'sesión',
  'ring.week': 'semana',
  'ring.resets.in': 'se reinicia en {until}',
  'ring.resets.at': 'se reinicia {time}',
  'ring.rolling': '7 días móviles',

  'pace.title': 'ritmo',
  'pace.window': 'ventana de {n} h',
  'pace.reset': 'se reinicia {time}',
  'pace.idle': 'Todavía no hay actividad en esta ventana.',

  'queue.title': 'cola',
  'queue.waiting': '{n} esperando',
  'queue.none': 'No hay nada esperando',
  'queue.empty': '¿Te quedaste a medias? Deja aquí el prompt. Se ejecuta solo cuando se reinicie tu ventana.',
  'queue.runNow': 'Ejecutar ya',
  'queue.remove': 'Quitar',
  'queue.edit': 'Editar',
  'queue.edit.save': 'Guardar',
  'queue.edit.saving': 'Guardando…',
  'queue.edit.cancel': 'Cancelar',
  'queue.edit.safety': 'Permisos',
  'queue.edit.when': 'Cuándo ejecutar',
  'queue.showFinished': 'Ver terminados',
  'queue.hideFinished': 'Ocultar terminados',
  'queue.spent': 'gastado',
  'queue.upTo': 'hasta {amount}',

  'compose.placeholder': 'Eso que no te dio tiempo a hacer…',
  'compose.pasted': 'Texto pegado',
  'compose.pasted.lines': '{n} líneas',
  'compose.pasted.chars': '{n} caracteres',
  'compose.pasted.remove': 'Quitar',
  'compose.pasted.expand': 'Ver',
  'compose.pasted.collapse': 'Ocultar',
  'compose.submit': 'Encolar',
  'compose.submitting': 'Encolando…',
  'compose.options': 'Opciones',
  'compose.hideOptions': 'Ocultar opciones',
  'compose.newSession': 'Sesión nueva',
  'compose.continue': 'Continuar: {title}',
  'compose.defaultModel': 'Modelo por defecto',
  'compose.forecast': 'Unos {p50}, hasta {p90}. Te deja al {after} de esta ventana.',
  'compose.forecastTight': 'Unos {p50}, hasta {p90}. No cabe en lo que te queda.',
  'compose.safety.plan': 'Solo planificar',
  'compose.safety.edits': 'Editar ficheros',
  'compose.safety.full': 'Sin restricciones',
  'compose.safety.plan.help': 'Lee y propone. No toca nada.',
  'compose.safety.edits.help': 'Edita ficheros y ejecuta herramientas sin preguntar.',
  'compose.safety.full.help': 'Sin ninguna restricción, dentro de esa carpeta. Se ejecuta sin ti delante.',
  'compose.when.onReset': 'Cuando se reinicie la ventana',
  'compose.when.asap': 'En cuanto quepa',
  'compose.when.manual': 'Solo cuando yo diga',
  'compose.when.at': 'A una hora que yo elija',
  'compose.when.at.help': 'Espera a ese momento y, a partir de ahí, a que quepa en la ventana.',
  'compose.when.at.past': 'Elige una hora que no haya pasado ya.',

  'worth.title': 'rentabilidad',
  'worth.line': '{used} de uso de API frente a {paid} de suscripción en 30 días ({rate}/mes son {daily}/día).',
  'worth.total': 'histórico',
  'worth.total.title': '{used} frente a {paid}, en {days} días desde el {since}',
  'worth.thisWeek': '{amount} esta semana',
  'worth.unknown': 'Aún no hay historial suficiente para decirlo.',
  'worth.today': 'hoy',
  'worth.yesterday': 'ayer',
  'worth.week': '7 días',
  'worth.month': '30 días',
  'worth.period.none': 'nada aún',
  'heat.title': 'Los últimos 30 días, un cuadro por día',
  'heat.less': 'menos',
  'heat.more': 'más',
  'heat.basis': 'un día del plan cuesta {amount}',
  'heat.none': '{when}: sin actividad',
  'heat.day': '{when} · {multiple}× la cuota del día · {amount}',

  'details.show': 'Detalles',
  'details.hide': 'Cerrar',

  'refresh.label': 'Actualizar — pedir las cifras de ahora',
  'refresh.failed': 'No se pudieron leer: {error}',

  'reach.title': 'Qué alcanzan estos números',
  'reach.gauges': 'Los anillos de Claude vienen de Anthropic, a través de Claude Code, y cubren toda tu cuenta: todos los dispositivos, y también el navegador.',
  'reach.priced.local': 'Todo lo que lleva un precio —el retorno, el ritmo de gasto, el mapa de calor— se reconstruye de los transcripts de esta máquina. El trabajo hecho en claude.ai o en otro ordenador no deja ninguno, así que falta en esas cifras y no hay forma de recuperarlo.',
  'reach.claude.path': 'Claude Code encontrado en este sistema.',
  'reach.claude.shim': 'Claude Code encontrado en este sistema, ejecutado mediante un intérprete de comandos.',
  'reach.claude.wsl': 'Claude Code encontrado dentro de WSL, en {bin}.',
  'reach.claude.configured': 'Claude Code indicado a mano, en {bin}.',
  'reach.claude.unknown': 'No se ha encontrado Claude Code. Sin él no se pueden leer los anillos — indica claudeBin en la configuración.',
  'reach.transcripts': 'Leyendo transcripts de {dir} — {count} proyectos.',
  'reach.transcripts.none': 'No hay transcripts en {dir}. Nada con precio puede calcularse hasta que los haya.',
  'reach.transcripts.remote': 'Se leen cruzando la frontera de WSL, y eso es lento: ejecutar tokio dentro de WSL y apuntar esta ventana ahí es más rápido.',
  'reach.transcripts.both': 'Se leen y fusionan los dos: una máquina con Claude Code instalado dos veces escribe en ambos, y leer solo uno dejaría fuera la otra mitad del gasto.',
  'reach.plan.detected': 'Plan leído de tu cuenta de Claude: {plan}.',
  'reach.plan.configured': 'Plan indicado a mano: {plan}.',
  'reach.plan.unknown': 'No se ha podido establecer tu plan, así que no se pone precio a nada. Los anillos nunca lo necesitaron; solo el retorno.',
  'reach.dismiss': 'Entendido',

  'detail.source': 'Origen del dato',
  'detail.source.reported': 'Lo reporta Claude Code',
  'detail.source.estimated': 'Estimado aquí',
  'detail.readAge': 'leído hace {age}',
  'detail.reread': 'Volver a leer',
  'detail.rereading': 'Leyendo…',
  'detail.reserve': 'Reserva que se respeta',
  'detail.reserve.help': 'Los trabajos en cola paran antes de comerse esto, para que siempre te quede algo.',
  'detail.accuracy': 'Precisión del pronóstico',
  'detail.accuracy.value': 'el {pct} de los trabajos cayó dentro de su rango',
  'detail.burn': 'Ritmo de gasto',
  'detail.remaining': 'Queda en esta ventana',
  'detail.of': 'de {total}',
  'detail.plan': 'Plan',
  'detail.plan.detected': 'Leído de tu cuenta de Claude ({evidence})',
  'detail.plan.configured': 'Puesto por ti, en el fichero de configuración',
  'detail.plan.unknown': 'No se pudo determinar — pon "plan" en tu configuración, o no hay rentabilidad que calcular',
  'detail.period': 'Periodo comparado',
  'detail.period.transcript': 'Desde el {since}, tu transcript más antiguo. Si ya pagabas antes, pon subscriptionStartedAt en la configuración.',
  'detail.period.configured': 'Desde el {since}, la fecha que indicaste.',
  'detail.turnsLeft': 'Peticiones que aún caben',
  'detail.turnsLeft.value': '{count} — una petición tuya cuesta {p50} de normal y {p90} cuando se dispara, sobre tus últimas {n}',
  'detail.opus': 'Opus esta semana',
  'detail.reconciliation': 'Contrastado con Claude Code',
  'detail.reconciliation.value': '{ours} aquí frente a {theirs} allí, en {n} sesión(es) que reportó.',
  'detail.prices': 'Precios por modelo, a tarifa de lista de la API.',
  'detail.month': 'Por mes',

  'calibrate.title': 'Estos límites son una suposición',
  'calibrate.help': 'Anthropic no los publica. Ejecuta /usage en Claude Code y escribe el porcentaje de 5 horas que te muestre.',
  'calibrate.action': 'Guardar',
  'calibrate.done': 'Guardado. Tu ventana de 5 horas es de unos {amount}.',

  'error.daemon': 'El daemon no responde.',
  'error.daemon.help': 'Arráncalo con tokio y esta página lo recogerá.',
  'error.stale': 'reconectando',

  'provider.claude': 'Claude',
  'provider.codex': 'Codex',

  'agents.title': '¿Qué IA usas?',
  'agents.help': 'tokio mide y encola para cada una que marques. Lo que se ha encontrado en este equipo ya viene marcado, y puedes cambiarlo después en Detalles.',
  'agents.claude': 'Claude Code',
  'agents.codex': 'Codex (OpenAI)',
  'agents.found.bin': 'encontrado en {bin}',
  'agents.found.home': 'no está en el PATH, pero su historial está en {home}',
  'agents.notFound': 'no se ha encontrado en este equipo',
  'agents.none': 'Marca al menos una.',
  'agents.save': 'Guardar',
  'agents.cancel': 'Cancelar',
  'agents.change': 'Cambiar',
  'agents.detail': 'IA en uso',

  'codex.ring.none': 'sin lectura actual',
  'codex.ring.stale': 'leído hace {age}',
  'codex.via.app-server': 'Lo reporta OpenAI, preguntado a través de Codex',
  'codex.via.rollout': 'Lo reporta OpenAI, con el último turno de Codex',
  'codex.via.app-server.short': 'lo reporta OpenAI',
  'codex.via.rollout.short': 'del último turno de Codex',
  'codex.via.none': 'Sin lectura actual de OpenAI: puede que la ventana se haya reiniciado, o que no se haya podido preguntar a Codex',
  'codex.verdict.weekFull': 'Codex ha agotado la cuota semanal.',
  'codex.verdict.floor': 'La última lectura de Codex indicaba un uso del {pct}.',
  'codex.verdict.none': 'Codex: no hay una lectura actual de su ventana.',
  'codex.verdict.ease': 'Codex va holgado: lleva el {pct} de su ventana.',
  'codex.verdict.tight': 'Codex va justo: lleva el {pct} de su ventana.',
  'codex.verdict.over': 'La ventana de Codex está casi agotada: lleva el {pct}.',
  'codex.verdict.limit': 'OpenAI da el límite de Codex por alcanzado.',
  'codex.verdict.resets': 'Se reinicia a las {time}.',
  'codex.detail.source': 'Codex, origen del dato',
  'codex.detail.probe': 'No se pudo preguntar a Codex',
  'codex.detail.plan': 'Plan de ChatGPT',
  'codex.detail.plan.value': '{plan}, según lo reporta OpenAI',
  'codex.detail.window': 'Codex, esta ventana',
  'codex.detail.today': 'Codex, hoy',
  'codex.detail.price': 'Codex en dólares',
  'codex.detail.price.none': 'No se muestra: aún no hay ningún precio de OpenAI copiado en tokio, así que Codex se cuenta en tokens.',
  'codex.detail.price.value': 'Precio de lista Standard de la API de OpenAI, leído en su web el {date}, con el recargo de más de 272K tokens: lo que costaría en la API, no lo que cobra tu plan. Es un mínimo, porque las búsquedas web, las escrituras en caché y el recargo regional no se cuentan. Lo que no fue en Standard, o un modelo sin precio, se queda en tokens.',
  'codex.usd.atLeast': 'al menos {amount}',
  'codex.usd.unpriced': 'sin total en dólares: {n} sin precio',
  'codex.tokens.value': '{input} de entrada ({cached} en caché) · {output} de salida, en {n} respuestas',
  'codex.tokens.none': 'nada ejecutado aquí',

  'compose.agent': 'IA',
  'compose.defaultModel.codex': 'Modelo por defecto de Codex',
  'compose.codex.forecast': 'Sin estimación: Codex informa de porcentajes, no de precios. Arranca cuando la ventana de Codex tenga hueco; ahora lleva el {pct}.',
  'compose.codex.forecast.none': 'Sin estimación: Codex informa de porcentajes, no de precios. Arranca cuando la ventana de Codex tenga hueco.',
  'queue.noEstimate': 'sin estimación',
  'queue.codex.basis': 'Codex informa de porcentajes, no de precios',

  'reach.codex.gauges': 'Los anillos de Codex vienen de OpenAI, a través del propio Codex, y cubren toda tu cuenta de ChatGPT.',
  'reach.codex.found': 'Codex encontrado en {bin}.',
  'reach.codex.unknown': 'No se ha encontrado la CLI de Codex, así que sus límites solo se pueden leer de lo que Codex ya ha escrito, tan recientes como su último turno.',
  'reach.codex.threads': 'Leyendo las sesiones de Codex de {home}: {count} en total.',
  'reach.codex.none': 'No hay sesiones de Codex en {home}.',
  'reach.codex.tokens': 'Codex se cuenta en tokens: no hay ningún precio de OpenAI copiado en tokio, así que nada de Codex lleva cifra en dólares.',
  'reach.codex.priced': 'Los dólares de Codex son el precio de lista Standard de la API de OpenAI, copiado de su web el {date}: un mínimo de lo que cobraría la API, no lo que cuesta tu plan. Los precios no se actualizan solos, y un modelo sin precio copiado se queda en tokens.',
};

const DICTS: Record<Lang, Dict> = { en, es };

const STORAGE_KEY = 'tokio.lang';

/** Spanish for a Spanish browser, English for everything else. */
function detect(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'es' || saved === 'en') return saved;
  } catch {
    // Private mode can refuse storage; fall through to the browser's setting.
  }
  const nav = typeof navigator === 'undefined' ? '' : navigator.language;
  return nav.toLowerCase().startsWith('es') ? 'es' : 'en';
}

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

export function useLang() {
  const [lang, setLang] = useState<Lang>(detect);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // Not being able to remember the choice is not a reason to refuse it.
    }
    document.documentElement.lang = lang;
  }, [lang]);

  const t = useCallback<Translate>(
    (key, vars) => {
      const template = DICTS[lang][key] ?? DICTS.en[key] ?? key;
      if (!vars) return template;
      return template.replace(/\{(\w+)\}/g, (whole, name) => String(vars[name] ?? whole));
    },
    [lang],
  );

  return { lang, setLang, t };
}

/** The locale to hand to Intl, so dates and times match the chosen language. */
export const localeOf = (lang: Lang): string => (lang === 'es' ? 'es-ES' : 'en-GB');
