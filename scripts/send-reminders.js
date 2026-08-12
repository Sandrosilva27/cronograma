import admin from 'firebase-admin';
import { Resend } from 'resend';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cores das categorias iguais ao front-end
const catColors = { 
  geral: '#64748b', 
  trabalho: '#3b82f6', 
  saude: '#10b981', 
  pessoal: '#ef4444'
};

// Função para formatar a data atual no fuso horário do Brasil (UTC-3) como YYYY-MM-DD
function getLocalDateStringInTz(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(date); // Retorna "YYYY-MM-DD"
}

async function run() {
  console.log("Iniciando script de lembretes diários...");

  // 1. Inicializar o Firebase Admin
  let app;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.log("Inicializando Firebase usando variável de ambiente (GitHub Secrets)...");
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  } else {
    console.log("Variável de ambiente FIREBASE_SERVICE_ACCOUNT não encontrada. Tentando carregar arquivo local service-account.json...");
    const serviceAccountPath = path.join(__dirname, '../service-account.json');
    app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccountPath)
    });
  }

  const db = admin.firestore();

  // 2. Inicializar o Resend
  if (!process.env.RESEND_API_KEY) {
    console.error("ERRO: A variável de ambiente RESEND_API_KEY não foi configurada!");
    process.exit(1);
  }
  const resend = new Resend(process.env.RESEND_API_KEY);

  // Obter data de amanhã em Brasília (America/Sao_Paulo)
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = getLocalDateStringInTz(tomorrow, 'America/Sao_Paulo');
  console.log(`Buscando tarefas pendentes para a data de amanhã: ${tomorrowStr}`);

  // 3. Buscar todas as tarefas não concluídas de amanhã no Firestore usando collectionGroup
  const tasksSnapshot = await db.collectionGroup('tasks')
    .where('date', '==', tomorrowStr)
    .where('done', '==', false)
    .get();

  if (tasksSnapshot.empty) {
    console.log("Nenhuma tarefa pendente encontrada para amanhã!");
    process.exit(0);
  }

  console.log(`Encontradas ${tasksSnapshot.size} tarefas pendentes. Agrupando por usuário...`);

  // 4. Agrupar tarefas por ID do usuário
  const userTasks = {};
  tasksSnapshot.forEach(doc => {
    const taskData = doc.data();
    const pathParts = doc.ref.path.split('/');
    const userId = pathParts[1]; // O caminho é: users/{userId}/tasks/{taskId}

    if (!userTasks[userId]) {
      userTasks[userId] = [];
    }

    userTasks[userId].push({
      id: doc.id,
      title: taskData.title,
      time: taskData.time,
      category: taskData.category || 'geral',
      label: taskData.label || ''
    });
  });

  const sender = process.env.EMAIL_SENDER || 'onboarding@resend.dev';
  console.log(`Remetente configurado: ${sender}`);

  // 5. Buscar e-mails no Firebase Auth, nomes no Firestore e disparar lembretes
  for (const userId of Object.keys(userTasks)) {
    try {
      // Obter e-mail do usuário no Firebase Auth
      const userRecord = await admin.auth().getUser(userId);
      const email = userRecord.email;

      if (!email) {
        console.log(`[-] Usuário ${userId} não possui e-mail registrado na autenticação. Pulando...`);
        continue;
      }

      // Obter nome do perfil no Firestore
      const userDoc = await db.collection('users').doc(userId).get();
      const userName = userDoc.exists && userDoc.data().name ? userDoc.data().name : 'Usuário';

      // Ordenar tarefas por hora
      const tasks = userTasks[userId].sort((a, b) => a.time.localeCompare(b.time));

      // Montar HTML da lista de tarefas
      const taskListHtml = tasks.map(t => {
        const labelBadge = t.label 
          ? `<span style="font-size: 12px; background-color: #f1f5f9; color: #475569; padding: 2px 8px; border-radius: 9999px; margin-left: 8px; font-weight: 500;">${t.label}</span>` 
          : '';
        return `
          <li style="margin-bottom: 12px; font-size: 16px; color: #334155; list-style-type: disc; margin-left: 20px;">
            <strong style="color: #0f172a;">${t.title}</strong> — às <strong>${t.time}</strong> ${labelBadge}
          </li>
        `;
      }).join('');

      // Determinar plural/singular para o texto
      const eventCountText = tasks.length === 1 ? '1 evento programado' : `${tasks.length} eventos programados`;

      // Montar o corpo do e-mail com design elegante e limpo (sem emojis como solicitado)
      const emailHtml = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px; border: 1px solid #e2e8f0; border-radius: 16px; background-color: #ffffff; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
          <h2 style="color: #0f172a; margin-top: 0; font-size: 22px; font-weight: 800; letter-spacing: -0.025em; margin-bottom: 16px;">Bom dia!</h2>
          <p style="color: #475569; font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
            Amanhã você tem <strong>${eventCountText}</strong>:
          </p>
          
          <ul style="padding-left: 0; margin: 0 0 24px 0;">
            ${taskListHtml}
          </ul>
          
          <p style="color: #475569; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">Fique atento aos horários para não perder nenhum compromisso.</p>
          
          <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
          <p style="color: #94a3b8; font-size: 12px; text-align: center; margin-bottom: 0;">Este é um envio automático do seu sistema de cronogramas pessoal.</p>
        </div>
      `;

      console.log(`[+] Enviando lembrete para ${email} (${userName}) com ${tasks.length} tarefas...`);

      // Disparar e-mail via Resend
      const { data, error } = await resend.emails.send({
        from: sender,
        to: [email],
        subject: `Lembrete: Suas Tarefas de Amanhã - ${tomorrowStr.split('-').reverse().join('/')}`,
        html: emailHtml
      });

      if (error) {
        console.error(`[-] Erro ao enviar e-mail para ${email}:`, error);
      } else {
        console.log(`[+] E-mail enviado com sucesso! ID: ${data.id}`);
      }

    } catch (err) {
      console.error(`[-] Falha ao processar o lembrete para o usuário ${userId}:`, err);
    }
  }

  console.log("Envio de lembretes concluído!");
  process.exit(0);
}

run().catch(err => {
  console.error("Erro crítico na execução do script:", err);
  process.exit(1);
});
