// background.js - Orquestador completo y corregido para AppFolio

const TARGET_PROPERTIES = [
  "Mariners Landing - 142",
  "Addisyn Park Apartments",
  "Division & Highland Rowhomes",
  "Talas Apartments",
  "Vista Highland",
  "Vista Palmera",
  "Platform 25",
  "Bella Vita - 1447 Sheryl Ln National City"
];

let isRunning = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function notifyUI(data) {
  chrome.runtime.sendMessage({ action: "UPDATE_PROGRESS", ...data }).catch(() => {});
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "START_AUTOMATION") {
    isRunning = true;
    startAutomationFlow(request.monthYear, sender.tab ? sender.tab.id : null);
    sendResponse({ status: "started" });
  } else if (request.action === "STOP_AUTOMATION") {
    isRunning = false;
    notifyUI({ state: "Detenido", log: "Automatización detenida por el usuario.", logType: "error", finished: true });
    sendResponse({ status: "stopped" });
  }
  return true;
});

async function startAutomationFlow(monthYear, initialTabId) {
  if (!initialTabId) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true, url: "https://*.appfolio.com/*" });
    if (tabs.length === 0) {
      notifyUI({ state: "Error", log: "No se encontró pestaña activa de AppFolio.", logType: "error", finished: true });
      return;
    }
    initialTabId = tabs[0].id;
  }

  const [year, month] = monthYear.split("-");
  let success = 0;
  let errors = 0;

  notifyUI({ processed: 0, success: 0, errors: 0, state: "Buscando reporte...", log: "Buscando 'Income Statement' en AppFolio...", logType: "info" });

  try {
    // PASO 1: Buscar "Income Statement" en la barra superior global
    await chrome.scripting.executeScript({
      target: { tabId: initialTabId },
      func: () => {
        const searchInput = document.querySelector('input[placeholder*="Search AppFolio"], input#search_query, input.search-input');
        if (searchInput) {
          searchInput.focus();
          searchInput.value = "Income Statement";
          searchInput.dispatchEvent(new Event('input', { bubbles: true }));
          setTimeout(() => {
            const items = Array.from(document.querySelectorAll('.search-result-item, .autocomplete-suggestion, a'))
              .find(el => el.textContent.trim() === "Income Statement");
            if (items) items.click();
          }, 800);
        }
      }
    });

    // PASO 2: Detectar la nueva pestaña del reporte abierta por AppFolio
    let reportTabId = await waitForNewReportTab(initialTabId, 15000);
    if (!reportTabId) {
      throw new Error("No se detectó la nueva pestaña del reporte generada por AppFolio.");
    }

    notifyUI({ state: "Pestaña conectada", log: "Conectado exitosamente a la pestaña del reporte.", logType: "success" });

    // PASO 3: Bucle secuencial para las 8 propiedades
    for (let i = 0; i < TARGET_PROPERTIES.length; i++) {
      if (!isRunning) break;
      const propName = TARGET_PROPERTIES[i];

      notifyUI({ 
        processed: success + errors, 
        success, 
        errors, 
        state: `Procesando (${i+1}/8)`, 
        log: `Configurando: ${propName}`, 
        logType: "info" 
      });

      try {
        await ensureTabReady(reportTabId);

        // Ejecutar acciones dentro de la pestaña del reporte
        const executed = await executeReportActions(reportTabId, propName, month, year);
        if (!executed) {
          throw new Error(`No se pudo completar la exportación para ${propName}.`);
        }

        success++;
        notifyUI({ 
          processed: success + errors, 
          success, 
          errors, 
          state: `Completada (${i+1}/8)`, 
          log: `Descargado: Income Statement - ${propName} - ${monthYear}.xlsx`, 
          logType: "success" 
        });

      } catch (err) {
        errors++;
        notifyUI({ 
          processed: success + errors, 
          success, 
          errors, 
          state: `Error en (${i+1}/8)`, 
          log: `Error en ${propName}: ${err.message}`, 
          logType: "error" 
        });
      }

      await sleep(3000); // Pausa de estabilidad entre propiedades
    }

    notifyUI({ 
      processed: success + errors, 
      success, 
      errors, 
      state: "Proceso finalizado", 
      log: `Finalizado. Exitosos: ${success} de 8, Errores: ${errors}`, 
      logType: "success", 
      finished: true 
    });
    isRunning = false;

  } catch (e) {
    notifyUI({ state: "Error Fatal", log: e.message, logType: "error", finished: true });
    isRunning = false;
  }
}

// Detector de la nueva pestaña abierta
function waitForNewReportTab(sourceTabId, timeoutMs) {
  return new Promise((resolve) => {
    let resolved = false;
    const listener = (tabId, changeInfo, tab) => {
      if (!resolved && tabId !== sourceTabId && tab.url && tab.url.includes("appfolio.com") && !tab.url.includes("/login")) {
        if (changeInfo.status === 'complete' || tab.status === 'complete') {
          resolved = true;
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(tabId);
        }
      }
    };
    chrome.tabs.onUpdated.addListener(listener);

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        chrome.tabs.onUpdated.removeListener(listener);
        chrome.tabs.query({ url: "https://*.appfolio.com/*" }, (tabs) => {
          const found = tabs.find(t => t.id !== sourceTabId && !t.url.includes("/login"));
          resolve(found ? found.id : null);
        });
      }
    }, timeoutMs);
  });
}

function ensureTabReady(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) return reject(new Error("La pestaña del reporte se cerró."));
      if (tab.status === 'complete') resolve(true);
      else {
        const updateListener = (id, info) => {
          if (id === tabId && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(updateListener);
            resolve(true);
          }
        };
        chrome.tabs.onUpdated.addListener(updateListener);
      }
    });
  });
}

// Inyección de acciones dentro de la pestaña del reporte (Forzar limpieza y tipeo idéntico al primer intento en cada iteración)
async function executeReportActions(tabId, propName, month, year) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: (pName, m, y) => {
      return new Promise(async (resolve) => {
        const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));

        // 1. Asegurar que el modal de Customize Report esté abierto
        let modal = Array.from(document.querySelectorAll('div, section, .modal'))
          .find(el => el.textContent && el.textContent.includes("Customize Report") && el.querySelector('input'));

        if (!modal) {
          const customizeBtn = Array.from(document.querySelectorAll('button, a, .btn'))
            .find(el => el.textContent && el.textContent.trim().toLowerCase().includes("customize"));
          if (customizeBtn) {
            customizeBtn.click();
            await sleepMs(1500);
          }
        }

        modal = Array.from(document.querySelectorAll('div, section, .modal'))
          .find(el => el.textContent && el.textContent.includes("Customize Report") && el.querySelector('input'));

        if (!modal) {
          resolve(false);
          return;
        }

        // 2. REINICIAR EL CAMPO DE PROPIEDADES (COMO LA PRIMERA VEZ)
        // Intentar hacer clic en la "X" de borrado si existe para quitar la selección previa
        const clearBtn = modal.querySelector('.Select-clear, [class*="clear"], button[title*="Clear"], .fa-close');
        if (clearBtn) {
          clearBtn.click();
          await sleepMs(600);
        }

        // Localizar el contenedor principal de Properties ("Search by property...")
        const propBoxContainer = Array.from(modal.querySelectorAll('div, span'))
          .find(el => el.textContent && el.textContent.includes("Search by property") || el.className.includes('Select-control'));

        if (propBoxContainer) {
          propBoxContainer.click(); // Abre el combobox limpio
          await sleepMs(800);

          // Buscar el input interno activo donde se debe escribir
          let searchInput = modal.querySelector('input[aria-autocomplete="list"], input[type="text"], .Select-input input');
          if (!searchInput) {
            searchInput = modal.querySelector('input[placeholder*="Search"]');
          }

          if (searchInput) {
            searchInput.focus();
            
            // Limpiar y asegurar que el input esté completamente vacío
            searchInput.value = "";
            searchInput.dispatchEvent(new Event('input', { bubbles: true }));
            await sleepMs(300);

            // Escribir obligatoriamente el nombre de la propiedad actual usando el setter nativo de React
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
            nativeSetter.call(searchInput, pName);
            searchInput.dispatchEvent(new Event('input', { bubbles: true }));
            searchInput.dispatchEvent(new Event('change', { bubbles: true }));
            searchInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
            
            await sleepMs(2000); // Esperar a que el menú despliegue las coincidencias filtradas

            // 3. SELECCIONAR LA OPCIÓN CORRECTA CON EL ICONO DE CASA
            const allElements = Array.from(document.querySelectorAll('div, li, span, [role="option"]'));
            
            const matchingOption = allElements.find(el => {
              const text = el.textContent ? el.textContent.trim().toLowerCase() : "";
              const hasName = text.includes(pName.toLowerCase());
              const hasHouseIcon = el.querySelector('svg, i, path, .fa-home') !== null;
              return hasName && hasHouseIcon;
            }) || allElements.find(el => {
              const text = el.textContent ? el.textContent.trim().toLowerCase() : "";
              return text.includes(pName.toLowerCase()) && (el.getAttribute('role') === 'option' || el.className.includes('option'));
            });

            if (matchingOption) {
              matchingOption.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
              matchingOption.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
              matchingOption.click();
            }
            
            // Refuerzo con Enter para fijar la opción seleccionada
            await sleepMs(500);
            searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          }
        }
        await sleepMs(1500);

        // 3.5 SELECCIONAR MES Y AÑO EN EL CALENDARIO "As of"
        const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        const targetMonth = MONTH_ABBR[parseInt(m, 10) - 1];
        const targetYear = String(parseInt(y, 10));
        const expectedAsOf = `${targetMonth} ${targetYear}`;

        const isVisibleEl = (el) => el && el.isConnected && el.getClientRects().length > 0;
        const realClick = (el) => {
          ['mousedown', 'mouseup', 'click'].forEach(t =>
            el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })));
        };

        // Input del "As of" (formato "Oct 2026"), con respaldo por la etiqueta
        const findAsOfInput = () => {
          let inp = Array.from(modal.querySelectorAll('input'))
            .find(i => /^[A-Za-z]{3}\s+\d{4}$/.test((i.value || '').trim()));
          if (!inp) {
            const lbl = Array.from(modal.querySelectorAll('label, div, span'))
              .find(el => el.children.length === 0 && el.textContent.trim() === "As of");
            if (lbl) {
              let row = lbl.parentElement;
              while (row && row !== modal && !row.querySelector('input')) row = row.parentElement;
              if (row && row !== modal) inp = row.querySelector('input');
            }
          }
          return inp;
        };

        // Botón del calendario junto al input
        const findCalendarBtn = (inp) => {
          let group = inp.parentElement;
          for (let k = 0; k < 3 && group; k++) {
            const btn = Array.from(group.querySelectorAll('button, [role="button"], .input-group-text, .input-group-append'))
              .find(b => b !== inp && !b.contains(inp));
            if (btn) return btn;
            group = group.parentElement;
          }
          return null;
        };

        // El desplegable del calendario: contiene "Today" y los 12 meses
        const getPicker = () => {
          const todayBtns = Array.from(document.querySelectorAll('button, a, div, span'))
            .filter(el => isVisibleEl(el) && el.children.length === 0 && el.textContent.trim() === "Today");
          for (const t of todayBtns) {
            let c = t.parentElement;
            while (c && c !== document.body) {
              const months = Array.from(c.querySelectorAll('*'))
                .filter(el => el.children.length === 0 && MONTH_ABBR.includes(el.textContent.trim()));
              if (months.length >= 12) return c;
              c = c.parentElement;
            }
          }
          return null;
        };

        const findLeaf = (container, text) => Array.from(container.querySelectorAll('*'))
          .find(el => isVisibleEl(el) && el.textContent.trim() === text &&
            !Array.from(el.children).some(ch => ch.textContent.trim() === text));

        const findYearNav = (container, goBack) => {
          const textMatch = goBack ? ['«', '⟪', '<<'] : ['»', '⟫', '>>'];
          const clsMatch = goBack ? /double-left|angles-left|chevrons-left/i : /double-right|angles-right|chevrons-right/i;
          const ariaMatch = goBack ? /prev.*year|previous year|prev.*decade/i : /next.*year|next.*decade/i;
          const el = Array.from(container.querySelectorAll('button, a, [role="button"], i, svg, span'))
            .find(e => isVisibleEl(e) && (
              textMatch.includes(e.textContent.trim()) ||
              clsMatch.test(e.getAttribute('class') || '') ||
              ariaMatch.test((e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || ''))));
          return el ? (el.closest('button, a, [role="button"]') || el) : null;
        };

        let asOfInput = findAsOfInput();
        if (!asOfInput) {
          resolve(false); // No se encontró el campo "As of": mejor fallar que descargar el mes equivocado
          return;
        }
        let calBtn = findCalendarBtn(asOfInput);

        const openPicker = async () => {
          let p = getPicker();
          if (p) return p;
          if (calBtn && calBtn.isConnected) realClick(calBtn);
          else { asOfInput.focus(); realClick(asOfInput); }
          await sleepMs(800);
          return getPicker();
        };

        // a) Abrir calendario y seleccionar el mes
        let picker = await openPicker();
        if (picker) {
          const mEl = findLeaf(picker, targetMonth);
          if (mEl) { realClick(mEl); await sleepMs(600); }
        }

        // b) Seleccionar el año (navegando con « / » si no está visible)
        picker = await openPicker();
        if (picker) {
          let yEl = findLeaf(picker, targetYear);
          let tries = 0;
          while (!yEl && picker && tries < 15) {
            const years = Array.from(picker.querySelectorAll('*'))
              .filter(el => isVisibleEl(el) && el.children.length === 0 && /^\d{4}$/.test(el.textContent.trim()))
              .map(el => parseInt(el.textContent.trim(), 10));
            if (!years.length) break;
            const nav = findYearNav(picker, parseInt(targetYear, 10) < Math.min(...years));
            if (!nav) break;
            realClick(nav);
            await sleepMs(400);
            picker = getPicker() || await openPicker();
            yEl = picker ? findLeaf(picker, targetYear) : null;
            tries++;
          }
          if (yEl) { realClick(yEl); await sleepMs(600); }
        }

        // c) Si el mes cambió al navegar por los años, volver a marcarlo
        if (!asOfInput.isConnected) asOfInput = findAsOfInput() || asOfInput;
        if ((asOfInput.value || '').trim() !== expectedAsOf) {
          picker = await openPicker();
          if (picker) {
            const mEl2 = findLeaf(picker, targetMonth);
            if (mEl2) { realClick(mEl2); await sleepMs(600); }
          }
        }

        // d) Respaldo: escribir el valor directamente en el input si los clics no lo fijaron
        if (!asOfInput.isConnected) asOfInput = findAsOfInput() || asOfInput;
        if ((asOfInput.value || '').trim() !== expectedAsOf) {
          const dateSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
          asOfInput.focus();
          dateSetter.call(asOfInput, expectedAsOf);
          asOfInput.dispatchEvent(new Event('input', { bubbles: true }));
          asOfInput.dispatchEvent(new Event('change', { bubbles: true }));
          asOfInput.dispatchEvent(new Event('blur', { bubbles: true }));
          await sleepMs(600);
        }

        // e) Cerrar el calendario si quedó abierto
        if (getPicker()) {
          if (calBtn && calBtn.isConnected) realClick(calBtn);
          await sleepMs(400);
          if (getPicker()) {
            const title = Array.from(modal.querySelectorAll('*'))
              .find(el => el.children.length === 0 && el.textContent.trim() === "Customize Report");
            if (title) realClick(title);
            await sleepMs(400);
          }
        }

        // f) Verificación final: si el mes no quedó, no exportar
        if (!asOfInput.isConnected) asOfInput = findAsOfInput() || asOfInput;
        if ((asOfInput.value || '').trim() !== expectedAsOf) {
          resolve(false);
          return;
        }
        await sleepMs(500);

        // 4. Configurar Accounting Basis a Accrual dentro del modal
        const basisSelect = Array.from(modal.querySelectorAll('select')).find(sel => 
          Array.from(sel.options).some(o => o.text.trim().includes("Accrual") || o.text.trim().includes("Cash"))
        );
        if (basisSelect) {
          const accrualOption = Array.from(basisSelect.options).find(o => o.text.trim() === "Accrual");
          if (accrualOption) {
            basisSelect.value = accrualOption.value;
            basisSelect.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }

        // 5. Asegurar Nivel de detalle (Detail View) dentro del modal
        const detailRadio = Array.from(modal.querySelectorAll('input[type="radio"]'))
          .find(el => el.parentElement && el.parentElement.textContent.includes("Detail View"));
        if (detailRadio) {
          detailRadio.click();
        }

        await sleepMs(1000);

        // 6. Hacer clic en el botón Update del modal
        const updateBtn = Array.from(modal.querySelectorAll('button, input[type="submit"]'))
          .find(el => el.textContent && el.textContent.trim() === "Update");
        
        if (updateBtn) {
          updateBtn.click();
          await sleepMs(7000); // Esperar a que el reporte cargue con la nueva propiedad

          // 7. Hacer clic en Actions -> Export as Excel en la barra superior
          const actionsBtn = Array.from(document.querySelectorAll('button, .btn'))
            .find(el => el.textContent && el.textContent.includes("Actions"));
          
          if (actionsBtn) {
            actionsBtn.click();
            await sleepMs(5000);

            const exportOpt = Array.from(document.querySelectorAll('a, button, .dropdown-item, li'))
              .find(el => el.textContent && el.textContent.trim().includes("Export as Excel"));
            
            if (exportOpt) {
              exportOpt.click();
              await sleepMs(7000); // Esperar consolidación de la descarga
              resolve(true);
            } else {
              resolve(false);
            }
          } else {
            resolve(false);
          }
        } else {
          resolve(false);
        }
      });
    },
    args: [propName, month, year]
  });

  return results && results[0] && results[0].result;
}