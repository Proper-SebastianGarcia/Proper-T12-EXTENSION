// content.js - Auxiliar de escucha activa
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "PING") {
    sendResponse({ status: "alive" });
  }
  return true;
});