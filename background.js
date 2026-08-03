function updateIconTheme(isDarkMode) {
  const prefix = isDarkMode ? 'white' : 'black';
  
  chrome.action.setIcon({
    path: {
      "16": `icons/16-${prefix}.png`,
      "32": `icons/32-${prefix}.png`,
      "48": `icons/48-${prefix}.png`,
      "96": `icons/96-${prefix}.png`,
      "128": `icons/128-${prefix}.png`
    }
  });
}

chrome.runtime.onStartup.addListener(() => {
  checkAndApplyTheme();
});

chrome.runtime.onInstalled.addListener(() => {
  checkAndApplyTheme();
});

function checkAndApplyTheme() {
  if (typeof matchMedia !== 'undefined') {
    const isDark = matchMedia('(prefers-color-scheme: dark)').matches;
    updateIconTheme(isDark);
  }
}