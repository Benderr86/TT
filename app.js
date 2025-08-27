// ====== Konfiguration (fülle das nach der App-Registrierung aus) ======
const msalConfig = {
  auth: {
    clientId: "DEIN_CLIENT_ID_HIER",
    authority: "https://login.microsoftonline.com/common",
    redirectUri: window.location.origin
  },
  cache: { cacheLocation: "localStorage", storeAuthStateInCookie: false }
};
const graphScopes = ["User.Read", "Files.ReadWrite", "offline_access"];

// ====== Storage Keys ======
const CURRENT_KEY = "workout.current.v1";
const HISTORY_KEY = "workout.history.v1";
const LAST_EXPORT_KEY = "workout.lastExportAt";

// ====== MSAL State (nur für Export) ======
let msalInstance;
let account;

// ====== App State ======
const state = {
  current: {
    date: new Date().toISOString().slice(0, 10),
    notes: "",
    exercises: [] // { id, name, sets: [ { no, reps, weight } ] }
  },
  history: [] // Array aus Sessions
};

// ====== Helpers ======
const $ = (sel) => document.querySelector(sel);
const uid = () => Math.random().toString(36).slice(2, 9);
const setStatus = (msg) => { $("#status").textContent = msg; };
const formatDateTimeForFile = (d = new Date()) =>
  d.toISOString().replace(/[:]/g, "-"); // sicher für Dateinamen

// ====== Storage ======
function loadLocal() {
  try {
    const c = localStorage.getItem(CURRENT_KEY);
    const h = localStorage.getItem(HISTORY_KEY);
    if (c) Object.assign(state.current, JSON.parse(c));
    if (h) state.history = JSON.parse(h);
  } catch {}
}
function saveCurrent() {
  localStorage.setItem(CURRENT_KEY, JSON.stringify(state.current));
}
function saveHistory() {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history));
}
function updateExportHint() {
  const ts = localStorage.getItem(LAST_EXPORT_KEY);
  const hint = $("#exportHint");
  if (!ts) {
    hint.textContent = "Hinweis: Noch kein Backup exportiert.";
    return;
  }
  const days = Math.floor((Date.now() - Number(ts)) / (1000 * 60 * 60 * 24));
  hint.textContent = days >= 7
    ? `Erinnerung: Letztes Backup vor ${days} Tagen.`
    : `Letztes Backup vor ${days} Tagen.`;
}

// ====== Rendering ======
function render() {
  $("#sessionDate").value = state.current.date || new Date().toISOString().slice(0,10);
  $("#sessionNotes").value = state.current.notes || "";

  const container = $("#exercises");
  container.innerHTML = "";
  state.current.exercises.forEach((ex, exIdx) => {
    const card = document.createElement("div");
    card.className = "exercise-card";

    const header = document.createElement("div");
    header.className = "exercise-header";

    const nameInput = document.createElement("input");
    nameInput.value = ex.name;
    nameInput.placeholder = "Übungsname";
    nameInput.addEventListener("input", (e) => {
      ex.name = e.target.value;
      saveCurrent();
    });

    const addSetBtn = document.createElement("button");
    addSetBtn.textContent = "Satz hinzufügen";
    addSetBtn.addEventListener("click", () => addSet(exIdx));

    const delExBtn = document.createElement("button");
    delExBtn.className = "danger";
    delExBtn.textContent = "Übung löschen";
    delExBtn.addEventListener("click", () => {
      state.current.exercises.splice(exIdx, 1);
      saveCurrent(); render();
    });

    header.appendChild(nameInput);
    header.appendChild(addSetBtn);
    header.appendChild(delExBtn);

    const setsWrap = document.createElement("div");
    setsWrap.className = "sets";

    ex.sets.forEach((s, sIdx) => {
      const row = document.createElement("div");
      row.className = "set-row";

      const no = document.createElement("div");
      no.className = "set-no";
      no.textContent = s.no;

      const reps = document.createElement("input");
      reps.type = "number"; reps.min = "0"; reps.inputmode = "numeric";
      reps.placeholder = "Reps";
      reps.value = s.reps ?? "";
      reps.addEventListener("input", (e) => {
        s.reps = e.target.value === "" ? null : parseInt(e.target.value, 10);
        saveCurrent();
      });

      const weight = document.createElement("input");
      weight.type = "number"; weight.step = "0.5"; weight.inputmode = "decimal";
      weight.placeholder = "Gewicht (kg)";
      weight.value = s.weight ?? "";
      weight.addEventListener("input", (e) => {
        s.weight = e.target.value === "" ? null : parseFloat(e.target.value);
        saveCurrent();
      });

      const delSetBtn = document.createElement("button");
      delSetBtn.className = "secondary";
      delSetBtn.textContent = "Entfernen";
      delSetBtn.addEventListener("click", () => {
        ex.sets.splice(sIdx, 1);
        ex.sets.forEach((ss, i) => ss.no = i + 1);
        saveCurrent(); render();
      });

      row.appendChild(no);
      row.appendChild(reps);
      row.appendChild(weight);
      row.appendChild(delSetBtn);
      setsWrap.appendChild(row);
    });

    const footer = document.createElement("div");
    footer.className = "card-actions";

    const left = document.createElement("div");
    left.textContent = `${ex.sets.length} Sätze`;

    const addQuick = document.createElement("button");
    addQuick.className = "secondary";
    addQuick.textContent = "+ Leer-Satz";
    addQuick.addEventListener("click", () => addSet(exIdx));

    footer.appendChild(left);
    footer.appendChild(addQuick);

    card.appendChild(header);
    card.appendChild(setsWrap);
    card.appendChild(footer);
    container.appendChild(card);
  });

  updateExportHint();
}

function addExercise(name = "") {
  state.current.exercises.push({ id: uid(), name, sets: [] });
  saveCurrent(); render();
}

function addSet(exIdx) {
  const ex = state.current.exercises[exIdx];
  const nextNo = ex.sets.length + 1;
  ex.sets.push({ no: nextNo, reps: null, weight: null });
  saveCurrent(); render();
}

function resetCurrentSession() {
  state.current = {
    date: new Date().toISOString().slice(0, 10),
    notes: "",
    exercises: []
  };
  saveCurrent(); render();
}

// ====== Session abschließen ======
function finishSession() {
  const copy = JSON.parse(JSON.stringify(state.current));
  // Ergänze einfache Metadaten
  copy.savedAt = new Date().toISOString();
  state.history.push(copy);
  saveHistory();
  resetCurrentSession();
  setStatus("Training gespeichert (offline) und neue Session gestartet.");
}

// ====== OneDrive Export (nur auf Knopfdruck) ======
async function ensureMsal() {
  if (!msalInstance) {
    msalInstance = new msal.PublicClientApplication(msalConfig);
    const accounts = msalInstance.getAllAccounts();
    if (accounts.length) {
      account = accounts[0];
      msalInstance.setActiveAccount(account);
    }
  }
}

async function getTokenInteractive() {
  await ensureMsal();
  try {
    const res = await msalInstance.acquireTokenSilent({
      scopes: graphScopes,
      account: msalInstance.getActiveAccount()
    });
    return res.accessToken;
  } catch {
    const res = await msalInstance.loginPopup({ scopes: graphScopes });
    account = res.account;
    msalInstance.setActiveAccount(account);
    const tokenRes = await msalInstance.acquireTokenSilent({
      scopes: graphScopes,
      account: msalInstance.getActiveAccount()
    });
    return tokenRes.accessToken;
  }
}

async function uploadJsonToOneDrive(fileName, jsonString) {
  const token = await getTokenInteractive();
  const endpoint = `https://graph.microsoft.com/v1.0/me/drive/root:/Apps/WorkoutLogger/${encodeURIComponent(fileName)}:/content`;
  const res = await fetch(endpoint, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: jsonString
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Upload fehlgeschlagen: ${res.status} ${txt}`);
  }
}

async function exportBackup() {
  if (!navigator.onLine) {
    setStatus("Du bist offline – Export nicht möglich.");
    return;
  }
  try {
    setStatus("Erstelle Backup und melde an OneDrive an …");
    // Stelle sicher, dass auch die aktuelle Session im Backup ist
    const fullHistory = [...state.history];
    if (state.current.exercises.length > 0 || (state.current.notes || "").trim() !== "") {
      const temp = JSON.parse(JSON.stringify(state.current));
      temp.savedAt = new Date().toISOString();
      temp._unsavedCurrent = true; // Kennzeichnung
      fullHistory.push(temp);
    }
    const payload = {
      exportedAt: new Date().toISOString(),
      sessionsCount: fullHistory.length,
      data: fullHistory
    };
    const json = JSON.stringify(payload, null, 2);
    const fileName = `WorkoutBackup_${formatDateTimeForFile()}.json`;
    await uploadJsonToOneDrive(fileName, json);

    localStorage.setItem(LAST_EXPORT_KEY, String(Date.now()));
    updateExportHint();
    setStatus(`Backup erfolgreich in OneDrive gespeichert: ${fileName}`);
  } catch (e) {
    console.error(e);
    setStatus(e.message || "Fehler beim Export.");
  }
}

// ====== Events ======
window.addEventListener("DOMContentLoaded", () => {
  loadLocal();
  render();

  $("#sessionDate").addEventListener("change", (e) => {
    state.current.date = e.target.value;
    saveCurrent();
  });
  $("#sessionNotes").addEventListener("input", (e) => {
    state.current.notes = e.target.value;
    saveCurrent();
  });
  $("#addExerciseBtn").addEventListener("click", () => {
    const name = $("#exerciseName").value.trim();
    addExercise(name);
    $("#exerciseName").value = "";
  });

  $("#saveLocalBtn").addEventListener("click", () => {
    saveCurrent();
    setStatus("Lokal gespeichert.");
  });
  $("#finishSessionBtn").addEventListener("click", finishSession);
  $("#exportBtn").addEventListener("click", exportBackup);

  // UX: Enter im Übungsfeld -> hinzufügen
  $("#exerciseName").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#addExerciseBtn").click();
  });

  updateExportHint();
});
