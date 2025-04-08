// Define types matching the ones in createPrViewProvider.ts
interface GitInfo {
    headBranch?: string;
    baseBranch?: string;
    remoteUrl?: string;
    owner?: string;
    repo?: string;
    changedFiles?: ChangedFile[];
    branches?: string[];
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
    | { command: 'getChangedFiles' }
    | { command: 'showError'; text: string };


interface VsCodeApi {
    postMessage(message: FromCreatePrWebviewMessage): void;
    getState(): any;
    setState(state: any): void;
}
declare const acquireVsCodeApi: () => VsCodeApi;

(function () {
    const vscode = acquireVsCodeApi();

    // Get references to form elements
    const baseBranchSelect = document.getElementById('base-branch-select') as HTMLSelectElement;
    const headBranchSelect = document.getElementById('head-branch-select') as HTMLSelectElement;
    const titleInput = document.getElementById('pr-title') as HTMLInputElement;
    const descriptionTextarea = document.getElementById('pr-description') as HTMLTextAreaElement;
    const filesChangedListDiv = document.getElementById('files-changed-list');
    const filesChangedCountSpan = document.getElementById('files-changed-count');
    const cancelButton = document.getElementById('cancel-button');
    const createButton = document.getElementById('create-button');

    // --- Helper function to populate dropdowns ---
    function populateBranchDropdown(selectElement: HTMLSelectElement, branches: string[] | undefined, defaultSelection?: string) {
        if (!selectElement) return;

        // Store current value if user already selected something maybe? (Optional)
        // const currentValue = selectElement.value;

        // Clear existing options (except maybe a placeholder if desired)
        selectElement.innerHTML = '<option value="">Select branch...</option>'; // Default placeholder

        if (!branches || branches.length === 0) {
            selectElement.innerHTML = '<option value="">No branches found</option>'; // Error state
            return;
        }

        branches.forEach(branch => {
            const option = document.createElement('option');
            option.value = branch;
            option.textContent = branch;
            if (branch === defaultSelection) {
                option.selected = true;
            }
            selectElement.appendChild(option);
        });

        // Re-apply currentValue if needed and exists in new options (Optional)
        // if (currentValue && branches.includes(currentValue)) {
        //    selectElement.value = currentValue;
        // }
    }
    


    // --- Event Listeners ---

    // Listen for messages from the extension host
    window.addEventListener('message', (event: MessageEvent<ToCreatePrWebviewMessage>) => {
        const message = event.data;
        if (message.command === 'loadFormData') {
            console.log('Received form data:', message.data);

            // --- Populate dropdowns and set defaults ---
            populateBranchDropdown(baseBranchSelect, message.data.branches, message.data.baseBranch);
            populateBranchDropdown(headBranchSelect, message.data.branches, message.data.headBranch);
            // --- End Populate ---

             // Suggest a default title based on head branch if title is empty
             if (!titleInput.value && message.data.headBranch) {
                 titleInput.value = formatBranchNameAsTitle(message.data.headBranch);
             }

            // Render files (ensure this gets called)
            if(message.data.changedFiles !== undefined) {
                renderFileList(message.data.changedFiles || []);
            } else {
                 // If changedFiles is undefined in payload, maybe request it?
                 // Or show loading state. For now, log:
                 console.log("Changed files data was not present in loadFormData message.");
            }
        }
    });

    // Handle Create button click 
    createButton?.addEventListener('click', (e) => {
        e.preventDefault();
        // --- Get values from select elements ---
        const base = baseBranchSelect.value;
        const head = headBranchSelect.value;
        // --- End Get values ---
        const title = titleInput.value;
        const body = descriptionTextarea.value;

        // Add validation for selected branch values
        if (!base || !head || !title) {
            console.error("Missing required fields (base, head, title)");
             vscode.postMessage({ command: 'showError', text: 'Please select base/head branches and enter a title.' }); // Example: Tell extension to show error
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

    // Ensure renderFileList is robust
    function renderFileList(files: ChangedFile[]) {
        if (!filesChangedListDiv || !filesChangedCountSpan) {
             console.error("Files list container or count span not found in DOM.");
             return; // Exit if elements aren't found
        }

        // --- Add log to confirm function runs and data received ---
         console.log(`Rendering ${files.length} files...`, files);
        // --- End log ---


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

            statusSpan.className = `file-status file-status-${file.status?.toLowerCase() ?? 'q'}`; // Handle potential undefined status
            statusSpan.textContent = file.status || '?'; // Show '?' if status is undefined

            pathSpan.textContent = file.path?.split(/[\\/]/).pop() || file.path || 'Unknown path'; // Handle potential undefined path
            pathSpan.title = file.path || '';
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