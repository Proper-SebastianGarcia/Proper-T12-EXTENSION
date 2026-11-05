document.addEventListener('DOMContentLoaded', async () => {
  const tabStatus = document.getElementById('tabStatus');
  const btnStart = document.getElementById('btnStart');
  const btnStop = document.getElementById('btnStop');
  const monthYearInput = document.getElementById('monthYearInput');
  const progressSection = document.getElementById('progressSection');
  
  const lblProcessed = document.getElementById('lblProcessed');
  const lblSuccess = document.getElementById('lblSuccess');
  const lblErrors = document.getElementById('lblErrors');
  const lblCurrentState = document.getElementById('lblCurrentState');
  const progressBar = document.getElementById('progressBar');
  const logsContainer = document.getElementById('logsContainer');

  // Mes por defecto (mes anterior)
  const today = new Date();
  today.setMonth(today.getMonth() - 1);
  monthYearInput.value = today.toISOString().slice(0, 7);

  // Verificar pestaña activa de AppFolio
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.includes('appfolio.com')) {
      tabStatus.textContent = "Pestaña válida de AppFolio detectada.";
      tabStatus.className = "status-box valid";
      btnStart.disabled = false;
    } else {
      tabStatus.textContent = "Abre una pestaña activa en AppFolio.";
      tabStatus.className = "status-box invalid";
    }
  } catch (e) {
    tabStatus.textContent = "No se pudo verificar la pestaña.";
    tabStatus.className = "status-box invalid";
  }

  function addLog(msg, type = 'info') {
    const div = document.createElement('div');
    div.className = `log-item log-${type}`;
    div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logsContainer.appendChild(div);
    logsContainer.scrollTop = logsContainer.scrollHeight;
  }

  btnStart.addEventListener('click', () => {
    const monthYear = monthYearInput.value;
    if (!monthYear) {
      alert("Selecciona el mes y año.");
      return;
    }

    btnStart.style.display = 'none';
    btnStop.style.display = 'inline-block';
    progressSection.style.display = 'block';
    logsContainer.innerHTML = '';

    chrome.runtime.sendMessage({
      action: "START_AUTOMATION",
      monthYear: monthYear
    });
  });

  btnStop.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: "STOP_AUTOMATION" });
    btnStart.style.display = 'inline-block';
    btnStop.style.display = 'none';
  });

  // Escuchar actualizaciones de estado desde background.js
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === "UPDATE_PROGRESS") {
      lblProcessed.textContent = request.processed || 0;
      lblSuccess.textContent = request.success || 0;
      lblErrors.textContent = request.errors || 0;
      lblCurrentState.textContent = request.state || "Procesando...";
      
      const pct = ((request.processed || 0) / 8) * 100;
      progressBar.style.width = `${pct}%`;

      if (request.log) {
        addLog(request.log, request.logType || 'info');
      }

      if (request.finished) {
        btnStart.style.display = 'inline-block';
        btnStop.style.display = 'none';
      }
    }
  });
});