// src/webview/analyzerMain.ts

interface VsCodeApi {
    postMessage(message: any): void;
    getState(): any;
    setState(state: any): void;
}
declare const acquireVsCodeApi: () => VsCodeApi;
const vscode = acquireVsCodeApi();

interface Message {
    type: 'user' | 'bot' | 'error' | 'thinking';
    text: string;
}

(function () {
    const messageList = document.getElementById('message-list') as HTMLDivElement;
    const questionInput = document.getElementById('question-input') as HTMLTextAreaElement;
    const sendButton = document.getElementById('send-button') as HTMLButtonElement;
    const presetButtonContainer = document.querySelector('.preset-questions');

    let thinkingMessageElement: HTMLDivElement | null = null;

    // --- Helper Functions ---

    function addMessageToUI(message: Message) {
        // Remove thinking indicator if it exists
        removeThinkingIndicator();

        const messageElement = document.createElement('div');
        messageElement.classList.add('message', `${message.type}-message`);

        let avatarClass = 'codicon-question'; // Default/Error/Thinking
        if (message.type === 'user') {
            avatarClass = 'codicon-account';
        } else if (message.type === 'bot') {
            avatarClass = 'codicon-hubot'; // Bot icon
        }

        // Basic structure, can be enhanced (e.g., with markdown parsing for bot messages)
        messageElement.innerHTML = `
            <span class="codicon ${avatarClass} avatar"></span>
            <div class="content">
                <p>${escapeHtml(message.text)}</p>
            </div>
        `;

        if (messageList) {
            messageList.appendChild(messageElement);
            // Scroll to the bottom
            messageList.scrollTop = messageList.scrollHeight;
        }
    }

    function showThinkingIndicator() {
        if (thinkingMessageElement) return; // Already showing

        thinkingMessageElement = document.createElement('div');
        thinkingMessageElement.classList.add('message', `thinking-message`);
        thinkingMessageElement.innerHTML = `
            <span class="codicon codicon-sync spin avatar"></span>
            <div class="content">
                <p><i>Thinking...</i></p>
            </div>
        `;
        if (messageList) {
            messageList.appendChild(thinkingMessageElement);
            messageList.scrollTop = messageList.scrollHeight;
        }
    }

    function removeThinkingIndicator() {
        if (thinkingMessageElement && thinkingMessageElement.parentNode) {
            thinkingMessageElement.parentNode.removeChild(thinkingMessageElement);
            thinkingMessageElement = null;
        }
    }


    function sendMessage(text: string) {
        const question = text.trim();
        if (!question) {
            return;
        }

        // Add user message to UI
        addMessageToUI({ type: 'user', text: question });

        // Send question to extension host
        vscode.postMessage({ command: 'askQuestion', text: question });

        // Clear input
        if (questionInput) {
            questionInput.value = '';
            adjustTextareaHeight(); // Reset height
        }

        // Show thinking indicator (optional)
        showThinkingIndicator();
    }

    function escapeHtml(unsafe: string): string {
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function adjustTextareaHeight() {
        if (!questionInput) return;
        questionInput.style.height = 'auto'; // Temporarily shrink
        const scrollHeight = questionInput.scrollHeight;
        // Set a max height (e.g., 150px)
        const maxHeight = 150;
        questionInput.style.height = `${Math.min(scrollHeight, maxHeight)}px`;
    }

    // --- Event Listeners ---

    sendButton?.addEventListener('click', () => {
        sendMessage(questionInput.value);
    });

    questionInput?.addEventListener('keydown', (event) => {
        // Send on Enter (Shift+Enter for newline)
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault(); // Prevent default newline
            sendMessage(questionInput.value);
        }
    });

    // Auto-resize textarea
    questionInput?.addEventListener('input', adjustTextareaHeight);


    // Preset question buttons
    presetButtonContainer?.addEventListener('click', (event) => {
        const target = event.target as HTMLButtonElement;
        if (target && target.classList.contains('preset-question-button')) {
            const question = target.dataset.question;
            if (question) {
                sendMessage(question);
            }
        }
    });

    // Listen for messages from the extension host
    window.addEventListener('message', event => {
        const message = event.data;
        console.log("Analyzer webview received message:", message); // Debugging

        switch (message.command) {
            case 'addBotMessage':
                removeThinkingIndicator(); // Ensure thinking is removed
                addMessageToUI({ type: 'bot', text: message.text });
                break;
            case 'addErrorMessage': // Handle potential errors from host
                removeThinkingIndicator();
                addMessageToUI({ type: 'error', text: `Error: ${message.text}` });
                break;
            // Add cases for 'initialData', 'showThinking' etc. if needed later
        }
    });

    // --- Initialization ---
    adjustTextareaHeight(); // Initial height adjustment
    vscode.postMessage({ command: 'webviewReady' });
    console.log("Analyzer webview script initialized.");

}());