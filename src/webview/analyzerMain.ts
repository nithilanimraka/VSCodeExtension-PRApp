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
    const inputArea = document.querySelector('.input-area') as HTMLDivElement; 

    let thinkingMessageElement: HTMLDivElement | null = null;
    let currentBotMessageElement: HTMLDivElement | null = null; // To hold the element being streamed into

    // --- Helper Functions ---

    function createMessageElement(message: Message): HTMLDivElement {
        const messageElement = document.createElement('div');
        messageElement.classList.add('message', `${message.type}-message`);

        let avatarClass = 'codicon-question'; // Default/Error/Thinking
        if (message.type === 'user') {
            avatarClass = 'codicon-account';
        } else if (message.type === 'bot') {
            avatarClass = 'codicon-hubot'; // Bot icon
        } else if (message.type === 'thinking') {
             avatarClass = 'codicon-sync spin'; // Ensure thinking uses spin icon
        } else if (message.type === 'error') {
             avatarClass = 'codicon-error';
        }


        // Use <pre> for bot content initially to preserve whitespace from chunks
        const contentTag = (message.type === 'bot' || message.type === 'thinking' || message.type === 'error') ? 'pre' : 'p';
        // Use italics for thinking message
        const messageText = message.type === 'thinking' ? `<i>${escapeHtml(message.text)}</i>` : escapeHtml(message.text);


        messageElement.innerHTML = `
            <span class="codicon ${avatarClass} avatar"></span>
            <div class="content">
                <${contentTag}>${messageText}</${contentTag}>
            </div>
        `;
        return messageElement;
    }

    function addMessageToUI(message: Message) {
        // Only remove thinking indicator if adding a *final* message (user or error)
        if (message.type === 'user' || message.type === 'error') {
             removeThinkingIndicator();
        }
        currentBotMessageElement = null; // Reset current bot message element if adding a new user/error message

        const messageElement = createMessageElement(message);

        if (messageList) {
            messageList.appendChild(messageElement);
            scrollToBottom();
        }
    }

    function startBotMessageStream() {
        // --- This is the primary place to remove the thinking indicator ---
        removeThinkingIndicator();
        // ------------------------------------------------------------------

        // Create a new bot message container but leave content empty initially
        currentBotMessageElement = createMessageElement({ type: 'bot', text: '' });
         // Ensure the content element exists before trying to access it later
        if (!currentBotMessageElement.querySelector('.content pre')) {
            const contentDiv = currentBotMessageElement.querySelector('.content');
            if (contentDiv) {
                const preElement = document.createElement('pre');
                contentDiv.appendChild(preElement);
            }
        }
        if (messageList) {
            messageList.appendChild(currentBotMessageElement);
            scrollToBottom();
        }
    }

    function appendToCurrentBotMessage(chunk: string) {
        if (currentBotMessageElement) {
            const contentDiv = currentBotMessageElement.querySelector('.content');
            // Target the <pre> tag specifically for appending streamed content
            const textElement = contentDiv?.querySelector('pre');
            if (textElement) {
                // Append text content directly to preserve whitespace and avoid HTML interpretation
                textElement.textContent += chunk;
                scrollToBottom(); // Keep scrolling as content grows
            }
        } else {
            // Fallback: If no current message element, create one (shouldn't happen with startBotMessage)
            console.warn("Received chunk but no current bot message element. Creating new one.");
            // Create a new message element for this chunk
            const messageElement = createMessageElement({ type: 'bot', text: chunk });
             if (messageList) {
                 messageList.appendChild(messageElement);
                 scrollToBottom();
             }
        }
    }

    function endBotMessageStream() {
        // Optional: Perform any cleanup after stream ends, e.g., markdown rendering
        if (currentBotMessageElement) {
            const contentDiv = currentBotMessageElement.querySelector('.content');
            const textElement = contentDiv?.querySelector('pre'); // Still target pre
            if (textElement) {
                // Example: If you want to render markdown *after* streaming is complete
                // try {
                //     const markdownHtml = yourMarkdownParser(textElement.textContent || '');
                //     contentDiv.innerHTML = markdownHtml; // Replace <pre> with rendered HTML
                // } catch (e) {
                //     console.error("Markdown parsing failed:", e);
                // }
            }
        }
        currentBotMessageElement = null; // Reset for the next message

        // --- Re-enable input when stream ends ---
        setInputDisabled(false);
        // ----------------------------------------
    }

    // function showThinkingIndicator() {
    //     if (thinkingMessageElement) return; // Already showing
    //     removeThinkingIndicator(); // Remove any previous one just in case
    //     currentBotMessageElement = null; // Cannot be streaming and thinking

    //     thinkingMessageElement = document.createElement('div');
    //     thinkingMessageElement.classList.add('message', `thinking-message`);
    //     thinkingMessageElement.innerHTML = `
    //         <span class="codicon codicon-sync spin avatar"></span>
    //         <div class="content">
    //             <p><i>Thinking...</i></p>
    //         </div>
    //     `;
    //     if (messageList) {
    //         messageList.appendChild(thinkingMessageElement);
    //         scrollToBottom();
    //     }
    // }

    function showThinkingIndicator() {
        if (thinkingMessageElement) return; // Already showing
        removeThinkingIndicator(); // Remove any previous one just in case
        currentBotMessageElement = null; // Cannot be streaming and thinking

        // Use createMessageElement for consistency
        thinkingMessageElement = createMessageElement({ type: 'thinking', text: 'Thinking...' });

        if (messageList) {
            messageList.appendChild(thinkingMessageElement);
            scrollToBottom();
        }
    }

    function removeThinkingIndicator() {
        if (thinkingMessageElement && thinkingMessageElement.parentNode === messageList) {
             try {
                messageList.removeChild(thinkingMessageElement);
             } catch (e) {
                  console.warn("Error removing thinking indicator:", e);
             }
        }
        thinkingMessageElement = null; // Always clear the reference
    }

    function scrollToBottom() {
        if (messageList) {
            messageList.scrollTop = messageList.scrollHeight;
        }
    }

    function setInputDisabled(disabled: boolean) {
        if (questionInput) {
            questionInput.disabled = disabled;
        }
        if (sendButton) {
            sendButton.disabled = disabled;
        }
        if (inputArea) {
            if (disabled) {
                inputArea.classList.add('disabled');
            } else {
                inputArea.classList.remove('disabled');
                // Re-focus input when enabled
                questionInput?.focus();
            }
        }
         // Also disable/enable preset buttons
         presetButtonContainer?.querySelectorAll('button').forEach(button => {
             (button as HTMLButtonElement).disabled = disabled;
         });
    }

    function sendMessage(text: string) {
        const question = text.trim();
        if (!question) {
            return;
        }

        // --- Disable input before sending ---
        setInputDisabled(true);
        // ------------------------------------

        // Add user message to UI
        addMessageToUI({ type: 'user', text: question });

        // Send question to extension host
        vscode.postMessage({ command: 'askQuestion', text: question });

        // Clear input
        if (questionInput) {
            questionInput.value = '';
            adjustTextareaHeight(); // Reset height
        }

        // Show thinking indicator IMMEDIATELY after sending
        showThinkingIndicator();
    }

    function escapeHtml(unsafe: string): string {
        // Basic escape, consider a library for more complex needs
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
        // Check if input is disabled before sending
        if (event.key === 'Enter' && !event.shiftKey && !questionInput.disabled) {
            event.preventDefault(); // Prevent default newline
            sendMessage(questionInput.value);
        }
    });

    // Auto-resize textarea
    questionInput?.addEventListener('input', adjustTextareaHeight);


    // Preset question buttons
    presetButtonContainer?.addEventListener('click', (event) => {
        const target = event.target as HTMLButtonElement;
        // Check if button is disabled before sending
        if (target && target.classList.contains('preset-question-button') && !target.disabled) {
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
            case 'startBotMessage':
                // This is now the main place to remove the indicator
                removeThinkingIndicator();
                startBotMessageStream();
                break;
            case 'addBotChunk':
                // No need to remove indicator here if startBotMessage is reliable
                appendToCurrentBotMessage(message.text);
                break;
            case 'endBotMessage':
                endBotMessageStream(); // This now re-enables input
                break;
            case 'addErrorMessage': // Handle potential errors from host
                // Remove thinking indicator if an error occurs
                removeThinkingIndicator();
                currentBotMessageElement = null; // Stop streaming if error occurs
                addMessageToUI({ type: 'error', text: `Error: ${message.text}` });
                // --- Re-enable input on error ---
                setInputDisabled(false);
                // --------------------------------
                break;
            // Add cases for 'initialData' etc. if needed later
        }
    });

    // --- Initialization ---
    adjustTextareaHeight(); // Initial height adjustment
    setInputDisabled(false); // Ensure input is enabled initially
    vscode.postMessage({ command: 'webviewReady' });
    console.log("Analyzer webview script initialized.");

}());