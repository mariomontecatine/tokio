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
  'worth.line': '{used} of API usage against {paid} of subscription over 30 days, at {rate}/month.',
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
};

const es: Dict = {

  'verdict.idle.turns': 'Nada en marcha. Te queda para {count} peticiones más como las tuyas.',
  'verdict.idle.none': 'Nada en marcha, y no queda para otra petición hasta que se reinicie la ventana.',
  'verdict.idle.pct': 'Nada en marcha. Te queda libre el {pct} de esta ventana.',
  'verdict.clear': 'Llegas al reset de sobra.',
  'verdict.clear.detail': 'A este ritmo acabas la ventana al {pct}.',
  'verdict.tight': 'Vas justo.',
  'verdict.tight.detail': 'A este ritmo acabas la ventana al {pct}.',
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
  'worth.line': '{used} de uso de API frente a {paid} de suscripción en 30 días, a {rate}/mes.',
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
