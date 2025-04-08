// Define types matching the ones in createPrViewProvider.ts
interface GitInfo {
    headBranch?: string;
    baseBranch?: string;
    remoteUrl?: string;
    owner?: string;
    repo?: string;
    changedFiles?: ChangedFile[];
}
interface ChangedFile {
    path: string;
    status: 'A' | 'M' | 'D' | 'R' | 'C' | '?';
}
type ToCreatePrWebviewMessage =
    | { command: 'loadFormData'; data: GitInfo };

type FromCreatePrWebviewMessage =
    | { command: 'webviewReady' }
    | { command: 'createPrRequest'; data: { base: string; head: string; title: string; body: string; } }
    | { command: 'cancelPr' }
    | { command: 'getChangedFiles' };


interface VsCodeApi {
    postMessage(message: FromCreatePrWebviewMessage): void;
    getState(): any;
    setState(state: any): void;
}
declare const acquireVsCodeApi: () => VsCodeApi;

(function () {
    const vscode = acquireVsCodeApi();

    // Get references to form elements
    const baseBranchInput = document.getElementById('base-branch') as HTMLInputElement;
    const headBranchInput = document.getElementById('head-branch') as HTMLInputElement;
    const titleInput = document.getElementById('pr-title') as HTMLInputElement;
    const descriptionTextarea = document.getElementById('pr-description') as HTMLTextAreaElement;
    const filesChangedListDiv = document.getElementById('files-changed-list');
    const filesChangedCountSpan = document.getElementById('files-changed-count');
    const cancelButton = document.getElementById('cancel-button');
    const createButton = document.getElementById('create-button');


    // --- Event Listeners ---

    // Listen for messages from the extension host
    window.addEventListener('message', (event: MessageEvent<ToCreatePrWebviewMessage>) => {
        const message = event.data;
        if (message.command === 'loadFormData') {
            console.log('Received form data:', message.data);
             // Update form only if data is provided for that field
            if(message.data.baseBranch !== undefined) baseBranchInput.value = message.data.baseBranch || '';
            if(message.data.headBranch !== undefined) headBranchInput.value = message.data.headBranch || '';

             // Suggest a default title based on head branch if title is empty
             if (!titleInput.value && message.data.headBranch) {
                 titleInput.value = formatBranchNameAsTitle(message.data.headBranch);
             }

            if(message.data.changedFiles !== undefined) renderFileList(message.data.changedFiles || []);
        }
    });

    // Handle Create button click
    createButton?.addEventListener('click', (e) => {
        e.preventDefault(); // Prevent default form submission
        const base = baseBranchInput.value;
        const head = headBranchInput.value;
        const title = titleInput.value;
        const body = descriptionTextarea.value;

        if (!base || !head || !title) {
            // Basic validation - ideally show message to user
            console.error("Missing required fields (base, head, title)");
            return;
        }

        vscode.postMessage({
            command: 'createPrRequest',
            data: { base, head, title, body }
        });
    });

    // Handle Cancel button click
    cancelButton?.addEventListener('click', () => {
        vscode.postMessage({ command: 'cancelPr' });
        // Optionally clear the form fields locally
        // titleInput.value = '';
        // descriptionTextarea.value = '';
        // baseBranchInput.value = ''; // Keep these maybe?
        // headBranchInput.value = '';
    });


    // --- Rendering Functions ---

     function formatBranchNameAsTitle(branchName: string): string {
         // Simple example: replace hyphens/underscores with spaces, capitalize words
         return branchName
             .replace(/[-_]/g, ' ')
             .replace(/\b\w/g, char => char.toUpperCase());
     }

    function renderFileList(files: ChangedFile[]) {
        if (!filesChangedListDiv || !filesChangedCountSpan) return;

        filesChangedListDiv.innerHTML = ''; // Clear previous list or loading message
        filesChangedCountSpan.textContent = String(files.length);

        if (files.length === 0) {
            filesChangedListDiv.innerHTML = '<p>No changes detected.</p>';
            return;
        }

        const ul = document.createElement('ul');
        files.forEach(file => {
            const li = document.createElement('li');
            const statusSpan = document.createElement('span');
            const pathSpan = document.createElement('span');

             // Basic styling per status
             statusSpan.className = `file-status file-status-${file.status.toLowerCase()}`;
             statusSpan.textContent = file.status;

             // Display relative path if possible (requires more work)
             // For now, just the filename
             pathSpan.textContent = file.path.split(/[\\/]/).pop() || file.path; // Show only filename
             pathSpan.title = file.path; // Show full path on hover
             pathSpan.className = 'file-path';


            li.appendChild(statusSpan);
            li.appendChild(pathSpan);
            ul.appendChild(li);
        });
        filesChangedListDiv.appendChild(ul);
    }


    // --- Initialization ---
    console.log("Create PR webview script initialized.");
    vscode.postMessage({ command: 'webviewReady' });
    // Optional: Request initial file list immediately if needed
    // vscode.postMessage({ command: 'getChangedFiles' });

}());