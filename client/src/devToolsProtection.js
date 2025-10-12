const DEFAULT_WARNING_MESSAGE = [
  '%cStealing our content is forbidden.',
  'If content is downloaded, reused, or redistributed we will take action with authorities.',
].join('\n');

const WARNING_STYLE = 'color: #fff; background-color: #c1121f; font-size: 28px; font-weight: 700; padding: 16px;';

const BLOCKED_SHORTCUTS = [
  { key: 'I', ctrl: true, shift: true },
  { key: 'J', ctrl: true, shift: true },
  { key: 'C', ctrl: true, shift: true },
  { key: 'K', ctrl: true, shift: true },
  { key: 'U', ctrl: true },
  { key: 'I', meta: true, shift: true },
  { key: 'J', meta: true, shift: true },
  { key: 'C', meta: true, shift: true },
  { key: 'K', meta: true, shift: true },
  { key: 'U', meta: true },
  { key: 'I', meta: true, alt: true },
  { key: 'J', meta: true, alt: true },
  { key: 'C', meta: true, alt: true },
  { key: 'K', meta: true, alt: true },
];

const matchesModifier = (required, actual) => {
  if (required === undefined) {
    return true;
  }

  return required === actual;
};

const isShortcutEvent = (event, shortcut) => {
  const keyMatches = event.key.toUpperCase() === shortcut.key;
  const ctrlMatches = matchesModifier(shortcut.ctrl, event.ctrlKey);
  const metaMatches = matchesModifier(shortcut.meta, event.metaKey);
  const shiftMatches = matchesModifier(shortcut.shift, event.shiftKey);
  const altMatches = matchesModifier(shortcut.alt, event.altKey);

  return keyMatches && ctrlMatches && metaMatches && shiftMatches && altMatches;
};

const shouldBlockEvent = (event) => {
  if (event.key === 'F12') {
    return true;
  }

  return BLOCKED_SHORTCUTS.some((shortcut) => isShortcutEvent(event, shortcut));
};

const showWarning = (message = DEFAULT_WARNING_MESSAGE) => {
  const formattedMessage = message.includes('%c') ? message : `%c${message}`;
  // eslint-disable-next-line no-console
  console.log(formattedMessage, WARNING_STYLE);
};

const createDevToolsDetector = (message) => {
  let warningShown = false;

  return () => {
    const widthGap = Math.abs(window.outerWidth - window.innerWidth);
    const heightGap = Math.abs(window.outerHeight - window.innerHeight);
    const isOpen = widthGap > 160 || heightGap > 160;

    if (isOpen && !warningShown) {
      warningShown = true;
      showWarning(message);
    } else if (!isOpen) {
      warningShown = false;
    }
  };
};

const initializeDevToolsProtection = (options = {}) => {
  const { enabled = true, warningMessage = DEFAULT_WARNING_MESSAGE } = options;

  if (!enabled) {
    return () => {};
  }

  const keyHandler = (event) => {
    if (shouldBlockEvent(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const contextMenuHandler = (event) => {
    event.preventDefault();
  };

  const detectDevTools = createDevToolsDetector(warningMessage);
  detectDevTools();
  const intervalId = window.setInterval(detectDevTools, 1000);

  window.addEventListener('keydown', keyHandler, true);
  window.addEventListener('contextmenu', contextMenuHandler, true);

  return () => {
    window.removeEventListener('keydown', keyHandler, true);
    window.removeEventListener('contextmenu', contextMenuHandler, true);
    window.clearInterval(intervalId);
  };
};

export default initializeDevToolsProtection;
