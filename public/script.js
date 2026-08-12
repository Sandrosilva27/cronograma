import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore, doc, setDoc, collection, updateDoc, deleteDoc, onSnapshot, writeBatch } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyDxdlxOBFtclmk4ncPDo_7Z_PjRZhJJMWA",
    authDomain: "fluxo2-12674.firebaseapp.com",
    projectId: "fluxo2-12674",
    storageBucket: "fluxo2-12674.firebasestorage.app",
    messagingSenderId: "259398408007",
    appId: "1:259398408007:web:2103c12d59995fdf499e62",
    measurementId: "G-B7WEC599VM"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app, "default");

const useLocalStorage = false;

// --- VARIÁVEIS DE ESTADO ---
let scheduleData = [];
let userData = { name: '' };
let viewingDate = new Date();
let currentWeekOffset = 0;
let weekDates = [];
let selectedCategory = 'geral';
const catColors = { geral: '#64748b', trabalho: '#3b82f6', saude: '#10b981', pessoal: '#ef4444'};
let tempProfilePhotoBase64 = null;
let editingTaskId = null;
let taskIdToDelete = null;

let unsubscribeTasks = null;
let unsubscribeProfile = null;

// --- FUNÇÃO AUXILIAR DE DATA LOCAL (Prevenção de Bug de Timezone) ---
function getLocalDateString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function timeToMinutes(timeStr) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
}

async function runWithTimeout(promise, errorMessage, timeoutMs = 5000) {
    const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error(errorMessage || "A conexão com o banco de dados expirou. Verifique se o Cloud Firestore está criado e ativo no Firebase Console.")), timeoutMs)
    );
    return Promise.race([promise, timeoutPromise]);
}

async function checkAndAutoCloseTasks() {
    const now = new Date();
    const tasksToUpdate = [];

    // Filtra tarefas que não estão concluídas
    scheduleData.forEach(t => {
        if (t.done) return;

        // Parse do horário de início local
        const startDateTime = new Date(`${t.date}T${t.time}`);
        // Se a data de início estiver no futuro, ignoramos
        if (startDateTime > now) return;

        let endDateTime;
        if (t.duration && parseInt(t.duration, 10) > 0) {
            endDateTime = new Date(startDateTime.getTime() + parseInt(t.duration, 10) * 60000);
        } else {
            // Regra padrão: 1 hora de duração
            endDateTime = new Date(startDateTime.getTime() + 60 * 60000);
            
            // Mas se houver outro evento na mesma data que comece antes de completar 1 hora
            const sameDayTasks = scheduleData.filter(x => x.date === t.date && x.id !== t.id);
            const nextTasks = sameDayTasks
                .filter(x => x.time > t.time)
                .sort((a, b) => a.time.localeCompare(b.time));
            
            if (nextTasks.length > 0) {
                const nextStart = new Date(`${t.date}T${nextTasks[0].time}`);
                if (nextStart < endDateTime) {
                    endDateTime = nextStart; // Ajusta fim para o início da próxima tarefa
                }
            }
        }

        if (now >= endDateTime) {
            tasksToUpdate.push(t.id);
        }
    });

    if (tasksToUpdate.length === 0) return;

    console.log("Auto-completing tasks:", tasksToUpdate);

    const user = auth.currentUser;
    if (!user) return;
    
    // Atualiza individualmente no Firestore
    for (const id of tasksToUpdate) {
        try {
            const taskRef = doc(db, "users", user.uid, "tasks", id);
            await updateDoc(taskRef, { done: true });
        } catch (e) {
            console.error("Erro ao auto-concluir tarefa:", id, e);
        }
    }
}

// --- OBSERVADOR DE ESTADO DE AUTENTICAÇÃO ---
onAuthStateChanged(auth, (user) => {
    if (user) {
        // Usuário logado: Exibe o sistema principal
        document.getElementById('view-login').classList.remove('active');
        document.getElementById('main-system').style.display = 'block';

        // Ouvinte em tempo real para o Perfil
        const profileRef = doc(db, "users", user.uid);
        if (unsubscribeProfile) unsubscribeProfile();
        unsubscribeProfile = onSnapshot(profileRef, (docSnap) => {
            if (docSnap.exists()) {
                userData = docSnap.data();
            } else {
                userData = { name: '' };
            }
            updateUIProfile();
        }, (error) => {
            console.error("Profile snapshot failed:", error);
        });

        // Ouvinte em tempo real para as Tarefas
        const tasksRef = collection(db, "users", user.uid, "tasks");
        if (unsubscribeTasks) unsubscribeTasks();
        unsubscribeTasks = onSnapshot(tasksRef, (querySnapshot) => {
            scheduleData = [];
            querySnapshot.forEach((doc) => {
                scheduleData.push({ id: doc.id, ...doc.data() });
            });
            
            // Verificar e auto-concluir tarefas vencidas
            checkAndAutoCloseTasks();

            // Recarrega a seção ativa
            const activeSection = document.querySelector('.view-section.active');
            if (activeSection) {
                const id = activeSection.id;
                if (id === 'view-home') renderHome();
                if (id === 'view-week') renderWeek();
                if (id === 'view-month') renderMonth();
            }
        }, (error) => {
            console.error("Tasks snapshot failed:", error);
        });
    } else {
        // Usuário deslogado: Limpa estado e exibe tela de login
        if (unsubscribeTasks) { unsubscribeTasks(); unsubscribeTasks = null; }
        if (unsubscribeProfile) { unsubscribeProfile(); unsubscribeProfile = null; }

        scheduleData = [];
        userData = { name: '' };

        document.getElementById('main-system').style.display = 'none';
        document.getElementById('view-login').classList.add('active');
    }
});

// --- FUNÇÕES GLOBAIS ---
window.validaLogin = async (modo) => {
    const btn = document.getElementById('btn-login');
    if (btn) {
        btn.classList.add('scale-95', 'opacity-90');
        setTimeout(() => {
            btn.classList.remove('scale-95', 'opacity-90');
        }, 150);
    }

    const email = document.getElementById('user-input').value.trim();
    const pass = document.getElementById('pass-input').value.trim();
    if (!email || !pass) return alert("Preencha e-mail e senha!");
    try {
        if (modo === 'create') {
            await createUserWithEmailAndPassword(auth, email, pass);
            alert("Conta criada com sucesso!");
        } else {
            await signInWithEmailAndPassword(auth, email, pass);
        }
        // A exibição do sistema será tratada automaticamente pelo onAuthStateChanged
    } catch (e) {
        alert("Erro de autenticação: " + e.message);
    }
};

window.logout = async () => {
    try {
        await signOut(auth);
    } catch (e) {
        alert("Erro ao sair: " + e.message);
    }
};

window.switchView = (id) => {
    document.querySelectorAll('.view-section').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    if (id === 'view-home') renderHome();
    if (id === 'view-week') {
        currentWeekOffset = 0;
        renderWeek();
    }
    if (id === 'view-month') renderMonth();
    if (id === 'view-panel' && !editingTaskId) {
        document.getElementById('panel-header-title').innerText = "Novo Plano";
        document.getElementById('btn-save-task').innerText = "Salvar Plano";
        document.getElementById('task-title').value = '';
        const labelInput = document.getElementById('task-label');
        if (labelInput) labelInput.value = '';
        document.getElementById('task-date').value = '';
        document.getElementById('task-time').value = '';
        const durInput = document.getElementById('task-duration');
        if (durInput) durInput.value = '';
        const durUnit = document.getElementById('task-duration-unit');
        if (durUnit) durUnit.value = 'minutos';
        const descInput = document.getElementById('task-desc');
        if (descInput) descInput.value = '';
        const importantCheckbox = document.getElementById('task-important');
        if (importantCheckbox) importantCheckbox.checked = false;
        const geralBtn = document.querySelector(`.cat-btn[onclick*="'geral'"]`);
        if (geralBtn) selectCat('geral', geralBtn);
    }
    lucide.createIcons();
};

window.selectCat = (cat, btn) => {
    selectedCategory = cat;
    document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active-cat'));
    btn.classList.add('active-cat');
};

window.addTask = async () => {
    const titleInput = document.getElementById('task-title');
    const labelInput = document.getElementById('task-label');
    const dateInput = document.getElementById('task-date');
    const timeInput = document.getElementById('task-time');
    const durationInput = document.getElementById('task-duration');
    const durationUnitSelect = document.getElementById('task-duration-unit');
    const descInput = document.getElementById('task-desc');
    const importantCheckbox = document.getElementById('task-important');

    const title = titleInput.value;
    const label = labelInput ? labelInput.value.trim() : '';
    const date = dateInput.value;
    const time = timeInput.value;
    const desc = descInput ? descInput.value.trim() : '';
    const important = importantCheckbox ? importantCheckbox.checked : false;

    if (!title || !date || !time) return alert("Preencha tudo!");

    let duration = null;
    if (durationInput && durationInput.value.trim() !== '') {
        const val = parseInt(durationInput.value, 10);
        if (!isNaN(val) && val > 0) {
            const unit = durationUnitSelect ? durationUnitSelect.value : 'minutos';
            duration = unit === 'horas' ? val * 60 : val;
        }
    }

    // --- DETECÇÃO DE CONFLITO DE HORÁRIO ---
    const newStart = timeToMinutes(time);
    const newDur = (duration && duration > 0) ? duration : 1;
    const newEnd = newStart + newDur;

    const overlappingTask = scheduleData.find(t => {
        if (t.date !== date) return false;
        if (editingTaskId && t.id === editingTaskId) return false; // Ignora a própria tarefa se estiver editando

        const tStart = timeToMinutes(t.time);
        const tDur = (t.duration && parseInt(t.duration, 10) > 0) ? parseInt(t.duration, 10) : 1;
        const tEnd = tStart + tDur;

        // Fórmula de sobreposição de intervalos: [StartA, EndA) e [StartB, EndB)
        return (newStart < tEnd && tStart < newEnd);
    });

    if (overlappingTask) {
        const formattedTime = t => {
            const start = t.time;
            if (t.duration && parseInt(t.duration, 10) > 0) {
                const totalMins = timeToMinutes(start) + parseInt(t.duration, 10);
                const hrs = String(Math.floor(totalMins / 60) % 24).padStart(2, '0');
                const mins = String(totalMins % 60).padStart(2, '0');
                return `${start} às ${hrs}:${mins}`;
            }
            return `${start}`;
        };
        
        const conflictIntervalText = formattedTime(overlappingTask);
        const modalMessage = `
            Você já tem um compromisso agendado neste horário:<br>
            <div class="my-4 p-3.5 bg-rose-50 border border-rose-100 rounded-2xl text-left">
                <span class="text-[9px] font-black text-rose-500 uppercase tracking-widest block mb-0.5">Conflito Encontrado</span>
                <strong class="text-slate-800 font-bold block text-sm mb-1">${overlappingTask.title}</strong>
                <span class="text-xs text-slate-500 font-semibold flex items-center gap-1">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" class="w-4 h-4 shrink-0 select-none">
                        <rect x="14" y="14" width="36" height="36" rx="8" transform="rotate(45 32 32)" fill="#f53d5f" />
                        <path d="M32 18 C30.8 18 30 18.8 30 20 L31 36 C31 36.5 31.4 37 32 37 C32.6 37 33 36.5 33 36 L34 20 C34 18.8 33.2 18 32 18 Z" fill="#ffffff" />
                        <circle cx="32" cy="44" r="2.5" fill="#ffffff" />
                    </svg>
                    ${conflictIntervalText}
                </span>
            </div>
            Por favor, defina outro horário ou edite o compromisso conflitante.
        `;
        showCustomAlert("Conflito de Horário", modalMessage);
        return; // Impede a adição
    }

    if (useLocalStorage) {
        if (editingTaskId) {
            const t = scheduleData.find(x => x.id === editingTaskId);
            if (t) {
                t.title = title;
                t.label = label;
                t.date = date;
                t.time = time;
                t.category = selectedCategory;
                t.duration = duration;
                t.desc = desc;
                t.important = important;
            }
            editingTaskId = null;
        } else {
            const newTask = {
                id: 'local_' + Date.now() + '_' + Math.random(),
                title,
                label,
                date,
                time,
                category: selectedCategory,
                done: false,
                duration,
                desc,
                important,
                createdAt: new Date().toISOString()
            };
            scheduleData.push(newTask);
        }
        localStorage.setItem("cronograma_tasks", JSON.stringify(scheduleData));
        
        titleInput.value = '';
        if (labelInput) labelInput.value = '';
        dateInput.value = '';
        timeInput.value = '';
        if (durationInput) durationInput.value = '';
        if (durationUnitSelect) durationUnitSelect.value = 'minutos';
        if (descInput) descInput.value = '';
        if (importantCheckbox) importantCheckbox.checked = false;
        window.switchView('view-home');
        return;
    }

    const user = auth.currentUser;
    if (!user) return alert("Usuário não está conectado!");

    try {
        if (editingTaskId) {
            const taskRef = doc(db, "users", user.uid, "tasks", editingTaskId);
            await runWithTimeout(
                updateDoc(taskRef, {
                    title,
                    label,
                    date,
                    time,
                    category: selectedCategory,
                    duration,
                    desc,
                    important
                }),
                "A conexão com o Firestore expirou ao tentar salvar o plano editado."
            );
            editingTaskId = null;
        } else {
            const taskColRef = collection(db, "users", user.uid, "tasks");
            const newTaskRef = doc(taskColRef);
            await runWithTimeout(
                setDoc(newTaskRef, {
                    title,
                    label,
                    date,
                    time,
                    category: selectedCategory,
                    done: false,
                    duration,
                    desc,
                    important,
                    createdAt: new Date().toISOString()
                }),
                "A conexão com o Firestore expirou ao tentar criar a tarefa. Certifique-se de que o banco de dados Firestore está criado e ativo no Firebase Console."
            );
        }

        // Limpa campos
        titleInput.value = '';
        if (labelInput) labelInput.value = '';
        dateInput.value = '';
        timeInput.value = '';
        if (durationInput) durationInput.value = '';
        if (durationUnitSelect) durationUnitSelect.value = 'minutos';
        if (descInput) descInput.value = '';
        if (importantCheckbox) importantCheckbox.checked = false;

        window.switchView('view-home');
    } catch (e) {
        alert("Erro ao salvar plano: " + e.message);
    }
};

window.mirrorWeek = async () => {
    const user = auth.currentUser;
    if (!user) return alert("Usuário não está conectado!");

    const startOfCurrent = new Date(weekDates[0]);
    const endOfCurrent = new Date(weekDates[6]);
    const tasksToCopy = scheduleData.filter(t => {
        const d = new Date(t.date + "T12:00:00");
        return d >= startOfCurrent && d <= endOfCurrent;
    });

    if (!tasksToCopy.length) return alert("Nenhuma tarefa para copiar nesta semana.");

    if (confirm(`Copiar ${tasksToCopy.length} tarefas para a próxima semana?`)) {
        try {
            const batch = writeBatch(db);
            tasksToCopy.forEach(t => {
                const d = new Date(t.date + "T12:00:00");
                d.setDate(d.getDate() + 7);

                const taskColRef = collection(db, "users", user.uid, "tasks");
                const newTaskRef = doc(taskColRef);
                batch.set(newTaskRef, {
                    title: t.title,
                    label: t.label || '',
                    date: getLocalDateString(d),
                    time: t.time,
                    category: t.category,
                    done: false,
                    createdAt: new Date().toISOString()
                });
            });
            await runWithTimeout(
                batch.commit(),
                "A conexão com o Firestore expirou ao tentar copiar as tarefas. Verifique se o Firestore está configurado no Firebase Console."
            );
            alert("Tarefas copiadas com sucesso!");
        } catch (e) {
            alert("Erro ao copiar tarefas: " + e.message);
        }
    }
};

window.saveProfile = async () => {
    const name = document.getElementById('user-name-input').value;

    // Se houver uma nova foto selecionada em Base64, salva no LocalStorage
    if (tempProfilePhotoBase64) {
        const localPhotoKey = getLocalPhotoKey();
        try {
            localStorage.setItem(localPhotoKey, tempProfilePhotoBase64);
        } catch (error) {
            console.error("Erro ao salvar imagem no LocalStorage:", error);
            alert("Não foi possível salvar a imagem localmente (excedeu o espaço do navegador). Escolha uma imagem menor.");
        }
        tempProfilePhotoBase64 = null; // reseta a variável temporária
    }



    const user = auth.currentUser;
    if (!user) return alert("Usuário não está conectado!");

    try {
        await runWithTimeout(
            setDoc(doc(db, "users", user.uid), {
                name
            }, { merge: true }),
            "A conexão com o Firestore expirou ao tentar salvar o perfil. Verifique se o Firestore está configurado no Firebase Console."
        );

        userData.name = name;
        updateUIProfile();
        window.switchView('view-home');
    } catch (e) {
        alert("Erro ao salvar perfil: " + e.message);
    }
};

window.toggleDone = async (id) => {
    const t = scheduleData.find(x => x.id === id);
    if (!t) return;



    const user = auth.currentUser;
    if (!user) return;

    try {
        const taskRef = doc(db, "users", user.uid, "tasks", id);
        await runWithTimeout(
            updateDoc(taskRef, { done: !t.done }),
            "A conexão com o Firestore expirou ao tentar atualizar o status da tarefa."
        );
    } catch (e) {
        alert("Erro ao atualizar tarefa: " + e.message);
    }
};

window.deleteTask = (id) => {
    showConfirmModal(id);
};

window.editTask = (id) => {
    const t = scheduleData.find(x => x.id === id);
    if (!t) return;

    editingTaskId = id;

    document.getElementById('task-title').value = t.title;
    const labelInput = document.getElementById('task-label');
    if (labelInput) labelInput.value = t.label || '';
    document.getElementById('task-date').value = t.date;
    document.getElementById('task-time').value = t.time;

    const durationInput = document.getElementById('task-duration');
    const durationUnitSelect = document.getElementById('task-duration-unit');
    if (t.duration) {
        if (t.duration % 60 === 0) {
            durationInput.value = t.duration / 60;
            durationUnitSelect.value = 'horas';
        } else {
            durationInput.value = t.duration;
            durationUnitSelect.value = 'minutos';
        }
    } else {
        if (durationInput) durationInput.value = '';
        if (durationUnitSelect) durationUnitSelect.value = 'minutos';
    }

    const descInput = document.getElementById('task-desc');
    if (descInput) descInput.value = t.desc || '';
    const importantCheckbox = document.getElementById('task-important');
    if (importantCheckbox) importantCheckbox.checked = !!t.important;

    const catBtn = document.querySelector(`.cat-btn[onclick*="'${t.category}'"]`);
    if (catBtn) selectCat(t.category, catBtn);

    document.getElementById('panel-header-title').innerText = "Editar Plano";
    document.getElementById('btn-save-task').innerText = "Salvar Alterações";

    window.switchView('view-panel');
};

window.resetToToday = () => { viewingDate = new Date(); renderHome(); };
window.goToDayFromWeek = (i) => { viewingDate = new Date(weekDates[i]); window.switchView('view-home'); };
window.goToDayFromDate = (dateStr) => { viewingDate = new Date(dateStr + "T12:00:00"); window.switchView('view-home'); };
window.changeMonth = (offset) => { viewingDate.setMonth(viewingDate.getMonth() + offset); renderMonth(); };
window.changeWeek = (offset) => { currentWeekOffset += offset; renderWeek(); };

function getLocalPhotoKey() {
    const user = auth.currentUser;
    return user ? `cronograma_photo_${user.uid}` : `cronograma_photo_offline`;
}

function updateUIProfile() {
    const defaultUserImg = "https://cdn-icons-png.flaticon.com/512/149/149071.png";
    const defaultCameraPlaceholder = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' fill='none'><circle cx='50' cy='50' r='50' fill='%23f0f9ff'/><path d='M68 38h-6.8l-3.4-5.1H42.2l-3.4 5.1H32c-3.3 0-6 2.7-6 6v22c0 3.3 2.7 6 6 6h36c3.3 0 6-2.7 6-6V44c0-3.3-2.7-6-6-6z' fill='%23bae6fd' stroke='%230284c7' stroke-width='4' stroke-linejoin='round'/><circle cx='50' cy='56' r='10' fill='%23bae6fd' stroke='%230284c7' stroke-width='4'/></svg>";
    
    // Obter foto local do LocalStorage baseado no usuário logado ou offline
    const localPhotoKey = getLocalPhotoKey();
    const localPhoto = localStorage.getItem(localPhotoKey);
    
    const photoForHeader = localPhoto && localPhoto.trim() !== "" ? localPhoto : defaultUserImg;
    const photoForPreview = localPhoto && localPhoto.trim() !== "" ? localPhoto : defaultCameraPlaceholder;
    
    document.getElementById('header-avatar').src = photoForHeader;
    document.getElementById('profile-preview').src = photoForPreview;
    document.getElementById('user-greeting').innerText = userData.name ? `Olá, ${userData.name}!` : "Olá!";
    document.getElementById('user-name-input').value = userData.name || '';
    
    // Resetar input de foto
    const photoInput = document.getElementById('user-photo-input');
    if (photoInput) {
        photoInput.value = '';
    }
    
    document.getElementById('header-avatar').onerror = function() { this.src = defaultUserImg; };
    document.getElementById('profile-preview').onerror = function() { this.src = defaultCameraPlaceholder; };
}

// --- FUNÇÃO AUXILIAR PARA FORMATAR DATAS EM DESTAQUE ---
function getShortFriendlyDateLabel(dateStr) {
    const today = new Date();
    
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    const tomorrowStr = getLocalDateString(tomorrow);
    
    if (dateStr === tomorrowStr) {
        return "Amanhã";
    }
    
    const dateParts = dateStr.split('-');
    const d = new Date(parseInt(dateParts[0], 10), parseInt(dateParts[1], 10) - 1, parseInt(dateParts[2], 10));
    const weekday = d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '');
    const capitalizedWeekday = weekday.charAt(0).toUpperCase() + weekday.slice(1);
    return `${capitalizedWeekday}, ${dateParts[2]}/${dateParts[1]}`;
}

function renderHome() {
    const dStr = getLocalDateString(viewingDate);
    document.getElementById('today-date-display').innerText = viewingDate.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
    document.getElementById('btn-back-today').classList.toggle('hidden', dStr === getLocalDateString(new Date()));

    const tasks = scheduleData.filter(t => t.date === dStr).sort((a,b) => a.time.localeCompare(b.time));
    const container = document.getElementById('today-tasks-container');
    container.innerHTML = tasks.length ? '' : '<p class="text-center opacity-30 mt-10 italic">Nenhum plano para hoje.</p>';
    
    tasks.forEach(t => {
        const color = catColors[t.category] || catColors.geral;
        const isImportant = !!t.important;
        const starHTML = isImportant ? `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" class="w-5 h-5 shrink-0 select-none">
            <rect x="14" y="14" width="36" height="36" rx="8" transform="rotate(45 32 32)" fill="#f53d5f" />
            <path d="M32 18 C30.8 18 30 18.8 30 20 L31 36 C31 36.5 31.4 37 32 37 C32.6 37 33 36.5 33 36 L34 20 C34 18.8 33.2 18 32 18 Z" fill="#ffffff" />
            <circle cx="32" cy="44" r="2.5" fill="#ffffff" />
        </svg>` : '';
        const todayCardBg = isImportant ? 'bg-gradient-to-br from-amber-50/20 to-white border-amber-200/50' : 'bg-white';
        const borderLeftStyle = isImportant ? 'border-left: 6px solid #f59e0b;' : `border-left: 6px solid ${color};`;
        
        let durationBadge = '';
        if (t.duration && t.duration > 0) {
            const hrs = Math.floor(t.duration / 60);
            const mins = t.duration % 60;
            const durationStr = hrs > 0 
                ? `${hrs}h${mins > 0 ? ` ${mins}m` : ''}` 
                : `${mins} min`;
            durationBadge = `<span class="ml-2 text-[9px] font-extrabold px-2 py-0.5 rounded-full bg-sky-100 text-sky-700 select-none flex items-center gap-1"><i data-lucide="clock" class="w-3 h-3 text-sky-600"></i> ${durationStr}</span>`;
        }

        const labelHTML = t.label ? `<div class="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-0.5">${t.label}</div>` : '';
        const descHTML = t.desc ? `<p class="text-xs text-slate-500 mt-1.5 bg-slate-50/80 p-2.5 rounded-xl border border-slate-100 font-medium leading-relaxed">${t.desc}</p>` : '';
        
        container.innerHTML += `
            <div class="premium-card p-5 flex items-center gap-4 min-h-[90px] shrink-0 ${t.done ? 'task-done' : ''} ${todayCardBg}" style="${borderLeftStyle}">
                <div class="flex-1">
                    ${labelHTML}
                    <div class="flex items-center gap-1.5 mb-0.5">
                        <span class="text-[9px] font-black uppercase text-sky-600">${t.time}</span>
                        ${durationBadge}
                    </div>
                    <div class="flex items-center gap-2">
                        ${starHTML}
                        <h4 class="font-bold text-slate-900">${t.title}</h4>
                    </div>
                    ${descHTML}
                </div>
                <button onclick="toggleDone('${t.id}')" class="w-10 h-10 rounded-xl border-2 flex items-center justify-center ${t.done ? 'bg-sky-600 border-sky-600' : 'bg-slate-50 border-slate-100'} shrink-0">
                    ${t.done ? '<i data-lucide="check" class="text-white w-5 h-5"></i>' : ''}
                </button>
                <div class="flex items-center gap-2 shrink-0">
                    <button onclick="editTask('${t.id}')" class="text-slate-300 hover:text-sky-600 transition-colors p-1" title="Editar"><i data-lucide="edit-3" class="w-4 h-4"></i></button>
                    <button onclick="deleteTask('${t.id}')" class="text-slate-300 hover:text-red-500 transition-colors p-1" title="Excluir"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
                </div>
            </div>`;
    });

    // --- RENDERIZAR PAINEL DE DESTAQUES (PRÓXIMOS 30 DIAS - COMPROMISSOS DO MÊS) ---
    const today = new Date();
    const next30Days = [];
    for (let i = 1; i <= 30; i++) {
        const nextD = new Date(today);
        nextD.setDate(today.getDate() + i);
        next30Days.push(getLocalDateString(nextD));
    }

    const highlightsTasks = scheduleData
        .filter(t => next30Days.includes(t.date) && !t.done)
        .sort((a, b) => {
            const dateComp = a.date.localeCompare(b.date);
            if (dateComp !== 0) return dateComp;
            return a.time.localeCompare(b.time);
        });

    const highlightsContainer = document.getElementById('highlights-tasks-container');
    if (highlightsContainer) {
        if (highlightsTasks.length === 0) {
            highlightsContainer.innerHTML = `
                <div class="flex flex-col items-center justify-center py-12 px-4 text-center opacity-40 w-full">
                    <i data-lucide="calendar-check" class="w-12 h-12 text-slate-400 mb-3"></i>
                    <p class="text-xs italic font-semibold text-slate-500">Nenhum compromisso pendente nos próximos 30 dias.</p>
                </div>
            `;
        } else {
            let highlightsHtml = '';
            highlightsTasks.forEach(t => {
                const color = catColors[t.category] || catColors.geral;
                const isImportant = !!t.important;
                const dateLabel = getShortFriendlyDateLabel(t.date);
                const starHTML = isImportant ? `
                <span class="flex items-center gap-1 text-[9px] font-black bg-rose-50 text-rose-600 border border-rose-100 px-2.5 py-0.5 rounded-full select-none shrink-0">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" class="w-3.5 h-3.5 shrink-0">
                        <rect x="14" y="14" width="36" height="36" rx="8" transform="rotate(45 32 32)" fill="#f53d5f" />
                        <path d="M32 18 C30.8 18 30 18.8 30 20 L31 36 C31 36.5 31.4 37 32 37 C32.6 37 33 36.5 33 36 L34 20 C34 18.8 33.2 18 32 18 Z" fill="#ffffff" />
                        <circle cx="32" cy="44" r="2.5" fill="#ffffff" />
                    </svg>
                    IMPORTANTE
                </span>` : '';
                const labelHTML = t.label ? `<span class="text-[9px] font-extrabold bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full uppercase tracking-wider">${t.label}</span>` : '';
                const cardBg = isImportant ? 'bg-gradient-to-br from-amber-50/30 to-white border-amber-200' : 'bg-white border-slate-100';
                const borderLeftStyle = isImportant ? 'border-left: 6px solid #f59e0b;' : `border-left: 5px solid ${color};`;
                
                let durationBadge = '';
                if (t.duration && t.duration > 0) {
                    const hrs = Math.floor(t.duration / 60);
                    const mins = t.duration % 60;
                    const durationStr = hrs > 0 
                        ? `${hrs}h${mins > 0 ? ` ${mins}m` : ''}` 
                        : `${mins}m`;
                    durationBadge = `<span class="text-[9px] font-extrabold text-sky-700 bg-sky-50 px-2 py-0.5 rounded-full flex items-center gap-1"><i data-lucide="clock" class="w-3.5 h-3.5 text-sky-600"></i> ${durationStr}</span>`;
                }

                const descHTML = t.desc ? `<div class="mt-2.5 text-xs text-slate-500 bg-slate-50/75 p-3 rounded-xl border border-slate-100/80 font-medium leading-relaxed">${t.desc}</div>` : '';

                const importantIconHTML = isImportant ? `
                <div class="shrink-0 flex items-center justify-center pt-0.5">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" class="w-9 h-9 select-none shrink-0">
                        <rect x="14" y="14" width="36" height="36" rx="8" transform="rotate(45 32 32)" fill="#f53d5f" />
                        <path d="M32 18 C30.8 18 30 18.8 30 20 L31 36 C31 36.5 31.4 37 32 37 C32.6 37 33 36.5 33 36 L34 20 C34 18.8 33.2 18 32 18 Z" fill="#ffffff" />
                        <circle cx="32" cy="44" r="2.5" fill="#ffffff" />
                    </svg>
                </div>` : '';

                highlightsHtml += `
                    <div onclick="goToDayFromDate('${t.date}')" class="premium-card p-5 flex flex-col gap-2.5 hover:scale-[1.01] hover:bg-slate-50/70 hover:shadow-md cursor-pointer transition-all duration-200" style="${borderLeftStyle} ${cardBg}">
                        <div class="flex justify-between items-center gap-2">
                            <span class="text-[10px] font-black text-sky-600 uppercase tracking-wider">${dateLabel} — ${t.time}</span>
                            <div class="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
                                ${durationBadge}
                                ${labelHTML}
                                ${starHTML}
                            </div>
                        </div>
                        <div class="flex items-start gap-3">
                            ${importantIconHTML}
                            <div class="flex-1 min-w-0">
                                <h5 class="font-extrabold text-slate-900 text-base leading-tight">${t.title}</h5>
                                ${descHTML}
                            </div>
                        </div>
                    </div>
                `;
            });
            highlightsContainer.innerHTML = highlightsHtml;
        }
    }

    lucide.createIcons();
    setTimeout(updateScrollFade, 50);
}

function renderWeek() {
    const today = new Date();
    const start = new Date(today);
    start.setDate(today.getDate() - today.getDay() + (currentWeekOffset * 7));
    document.getElementById('week-title').innerText = start.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    weekDates = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(start); 
        d.setDate(start.getDate() + i);
        const dStr = getLocalDateString(d);
        weekDates.push(new Date(d));
        const col = document.getElementById(`day-${i}`);
        col.className = `day-column ${dStr === getLocalDateString(new Date()) ? 'today' : ''}`;
        const weekdayNames = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
        col.innerHTML = `
            <div class="flex justify-between md:justify-center items-center md:flex-col mb-2 border-b border-slate-100 md:border-none pb-2 md:pb-0">
                <span class="md:hidden font-black text-xs uppercase tracking-wider text-slate-500">${weekdayNames[i]}</span>
                <span class="font-extrabold text-sm md:text-xs text-sky-700 md:text-slate-600 bg-sky-50 md:bg-transparent px-2.5 py-1 md:p-0 rounded-full">${d.getDate()}</span>
            </div>
        `;
        
        scheduleData
            .filter(t => t.date === dStr)
            .sort((a, b) => a.time.localeCompare(b.time))
            .forEach(t => {
                const color = catColors[t.category] || catColors.geral;
                const doneClass = t.done ? 'task-done' : '';
                const weekLabelHTML = t.label ? `<span class="block text-[9px] opacity-75 font-extrabold truncate uppercase">${t.label}</span>` : '';
                col.innerHTML += `
                    <div class="mini-task ${doneClass}" style="background:${color}" title="${t.title}">
                        ${weekLabelHTML}
                        <span class="block text-[11px] opacity-90 font-black mb-0.5">${t.time}</span>
                        <span class="block break-all">${t.title}</span>
                    </div>
                `;
            });
    }
}

function renderMonth() {
    const year = viewingDate.getFullYear();
    const month = viewingDate.getMonth();
    
    const monthTitleStr = viewingDate.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    document.getElementById('month-title').innerText = monthTitleStr.charAt(0).toUpperCase() + monthTitleStr.slice(1);

    const firstDayOfMonth = new Date(year, month, 1);
    const startDayOfWeek = firstDayOfMonth.getDay();
    const totalDaysInMonth = new Date(year, month + 1, 0).getDate();
    const totalDaysInPrevMonth = new Date(year, month, 0).getDate();

    const container = document.getElementById('month-days-container');
    container.innerHTML = '';
    const todayStr = getLocalDateString(new Date());

    // 1. Dias do mês anterior (prefixo)
    for (let i = startDayOfWeek - 1; i >= 0; i--) {
        const prevDay = totalDaysInPrevMonth - i;
        const prevMonthDate = new Date(year, month - 1, prevDay);
        const dStr = getLocalDateString(prevMonthDate);
        container.innerHTML += renderMonthDayCell(prevDay, dStr, true, todayStr);
    }

    // 2. Dias do mês atual
    for (let day = 1; day <= totalDaysInMonth; day++) {
        const currentMonthDate = new Date(year, month, day);
        const dStr = getLocalDateString(currentMonthDate);
        container.innerHTML += renderMonthDayCell(day, dStr, false, todayStr);
    }

    // 3. Dias do próximo mês (sufixo)
    const totalCellsSoFar = startDayOfWeek + totalDaysInMonth;
    const cellsNeeded = totalCellsSoFar % 7 === 0 ? 0 : 7 - (totalCellsSoFar % 7);
    for (let day = 1; day <= cellsNeeded; day++) {
        const nextMonthDate = new Date(year, month + 1, day);
        const dStr = getLocalDateString(nextMonthDate);
        container.innerHTML += renderMonthDayCell(day, dStr, true, todayStr);
    }
    
    lucide.createIcons();
}

function renderMonthDayCell(day, dStr, isOtherMonth, todayStr) {
    const isToday = dStr === todayStr;
    const tasks = scheduleData.filter(t => t.date === dStr);
    
    let cellClass = 'month-day';
    if (isToday) cellClass += ' today';
    if (isOtherMonth) cellClass += ' other-month';

    let desktopHTML = '';
    let mobileHTML = '';
    
    if (tasks.length > 0) {
        const labelText = tasks.length === 1 ? '1 evento!' : `${tasks.length} eventos!`;
        desktopHTML = `
            <div class="hidden md:flex flex-1 items-center justify-center w-full pb-2">
                <span class="bg-sky-100 border border-sky-200 text-sky-800 text-[10px] md:text-sm font-black tracking-wide px-2 py-1 md:px-4 md:py-2 rounded-2xl shadow-sm">
                    ${labelText}
                </span>
            </div>
        `;
        
        mobileHTML = `
            <div class="flex md:hidden items-center justify-center pb-1 w-full">
                <span class="w-[18px] h-[18px] bg-gradient-to-br from-sky-400 to-sky-600 text-white text-[9px] font-black rounded-full flex items-center justify-center shadow-sm select-none">
                    ${tasks.length}
                </span>
            </div>
        `;
    }

    return `
        <div class="${cellClass}" onclick="goToDayFromDate('${dStr}')">
            <div class="month-day-number">${day}</div>
            ${desktopHTML}
            ${mobileHTML}
        </div>
    `;
}

// --- OUVINTE PARA IMPORTAÇÃO DE FOTO DE PERFIL ---
document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'user-photo-input') {
        const file = e.target.files[0];
        if (file) {
            // Limitar a 1.5MB para evitar ultrapassar o limite do LocalStorage (geralmente 5MB)
            if (file.size > 1.5 * 1024 * 1024) {
                alert("A imagem selecionada é muito grande! Por favor, escolha uma imagem de até 1.5MB.");
                e.target.value = '';
                return;
            }
            const reader = new FileReader();
            reader.onload = (event) => {
                tempProfilePhotoBase64 = event.target.result;
                const previewImg = document.getElementById('profile-preview');
                if (previewImg) {
                    previewImg.src = tempProfilePhotoBase64;
                }
            };
            reader.readAsDataURL(file);
        }
    }
});

// --- VERIFICAÇÃO PERIÓDICA DE FECHAMENTO AUTOMÁTICO DE TAREFAS ---
setInterval(checkAndAutoCloseTasks, 30000);

// --- CONTROLE DE SCROLL E GRADIENTE FADE (TAREFAS HOME) ---
function updateScrollFade() {
    const container = document.getElementById('today-tasks-container');
    const fade = document.getElementById('scroll-fade-indicator');
    if (!container || !fade) return;
    const scrollable = container.scrollHeight > container.clientHeight;
    // Verifica se o usuário chegou próximo ao fim (10px)
    const scrolledToBottom = Math.ceil(container.scrollTop + container.clientHeight) >= container.scrollHeight - 10;
    
    if (scrollable && !scrolledToBottom) {
        fade.classList.remove('opacity-0');
        fade.classList.add('opacity-100');
    } else {
        fade.classList.remove('opacity-100');
        fade.classList.add('opacity-0');
    }
}

// Inicializa ouvinte de scroll para atualizar o indicador de fade
setTimeout(() => {
    const container = document.getElementById('today-tasks-container');
    if (container) {
        container.addEventListener('scroll', updateScrollFade);
        window.addEventListener('resize', updateScrollFade);
    }
}, 500);

// --- MODAL DE CONFIRMAÇÃO DE DELEÇÃO CUSTOMIZADO ---
function showConfirmModal(id) {
    taskIdToDelete = id;
    const modal = document.getElementById('confirm-modal');
    const box = document.getElementById('confirm-modal-box');
    if (modal && box) {
        modal.classList.remove('opacity-0', 'pointer-events-none');
        box.classList.remove('scale-95');
        box.classList.add('scale-100');
    }
}

function hideConfirmModal() {
    taskIdToDelete = null;
    const modal = document.getElementById('confirm-modal');
    const box = document.getElementById('confirm-modal-box');
    if (modal && box) {
        modal.classList.add('opacity-0', 'pointer-events-none');
        box.classList.remove('scale-100');
        box.classList.add('scale-95');
    }
}

async function executeDeleteTask() {
    if (!taskIdToDelete) return;
    const id = taskIdToDelete;
    
    hideConfirmModal();

    if (useLocalStorage) {
        scheduleData = scheduleData.filter(x => x.id !== id);
        localStorage.setItem("cronograma_tasks", JSON.stringify(scheduleData));
        
        const activeSection = document.querySelector('.view-section.active');
        if (activeSection) {
            const secId = activeSection.id;
            if (secId === 'view-home') renderHome();
            if (secId === 'view-week') renderWeek();
            if (secId === 'view-month') renderMonth();
        }
        return;
    }

    const user = auth.currentUser;
    if (!user) return;

    try {
        const taskRef = doc(db, "users", user.uid, "tasks", id);
        await runWithTimeout(
            deleteDoc(taskRef),
            "A conexão com o Firestore expirou ao tentar excluir a tarefa."
        );
    } catch (e) {
        alert("Erro ao excluir tarefa: " + e.message);
    }
}

// Inicializar listeners do modal de confirmação
const confirmModal = document.getElementById('confirm-modal');
const cancelBtn = document.getElementById('confirm-cancel-btn');
const deleteBtn = document.getElementById('confirm-delete-btn');

if (cancelBtn) cancelBtn.addEventListener('click', hideConfirmModal);
if (deleteBtn) deleteBtn.addEventListener('click', executeDeleteTask);
if (confirmModal) {
    confirmModal.addEventListener('click', (e) => {
        if (e.target === confirmModal) {
            hideConfirmModal();
        }
    });
}

// --- FUNÇÕES E LISTENERS DO MODAL DE ALERTA CUSTOMIZADO ---
function showCustomAlert(title, message) {
    const modal = document.getElementById('alert-modal');
    const box = document.getElementById('alert-modal-box');
    const titleEl = document.getElementById('alert-modal-title');
    const msgEl = document.getElementById('alert-modal-message');
    
    if (modal && box && titleEl && msgEl) {
        titleEl.innerText = title;
        msgEl.innerHTML = message;
        modal.classList.remove('opacity-0', 'pointer-events-none');
        box.classList.remove('scale-95');
        box.classList.add('scale-100');
        lucide.createIcons();
    }
}

function hideCustomAlert() {
    const modal = document.getElementById('alert-modal');
    const box = document.getElementById('alert-modal-box');
    if (modal && box) {
        modal.classList.add('opacity-0', 'pointer-events-none');
        box.classList.remove('scale-100');
        box.classList.add('scale-95');
    }
}

window.showCustomAlert = showCustomAlert;
window.hideCustomAlert = hideCustomAlert;

const alertModal = document.getElementById('alert-modal');
const alertBtn = document.getElementById('alert-modal-btn');
if (alertBtn) alertBtn.addEventListener('click', hideCustomAlert);
if (alertModal) {
    alertModal.addEventListener('click', (e) => {
        if (e.target === alertModal) {
            hideCustomAlert();
        }
    });
}


