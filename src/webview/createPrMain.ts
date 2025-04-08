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
    | { command: 'showError'; text: string }
    | { command: 'compareBranches'; base: string; head: string };


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

    // --- Store the branches list locally ---
    let availableBranches: string[] | undefined = undefined;

    // --- Event Listeners ---

    // Listen for messages from the extension host
    window.addEventListener('message', (event: MessageEvent<ToCreatePrWebviewMessage>) => {
        const message = event.data;
        if (message.command === 'loadFormData') {
            console.log('Webview received form data:', message.data);

            // ONLY populate branches if the message actually contains them
            if (message.data.branches !== undefined) {
                availableBranches = message.data.branches; // Store the branches
                console.log("Populating branch dropdowns.");
                populateBranchDropdown(baseBranchSelect, availableBranches, message.data.baseBranch);
                populateBranchDropdown(headBranchSelect, availableBranches, message.data.headBranch);
            }

            // Set title if applicable (can happen on initial load)
            if (message.data.branches !== undefined && !titleInput.value && message.data.headBranch) {
                titleInput.value = formatBranchNameAsTitle(message.data.headBranch);
            }

            // Update files list if present in the message
            if(message.data.changedFiles !== undefined) {
                console.log("Updating file list.");
                renderFileList(message.data.changedFiles || []);
            } else if (message.data.branches !== undefined) {
                 // If it was an initial load (branches present) but no files, clear/reset file list
                 console.log("Initial load, resetting file list.");
                 renderFileList([]); // Render empty state initially
            }
        }
    });

    // --- Listener for branch changes ---
    let compareTimeout: number | undefined;
    function handleBranchChange() {
        // Clear previous timeout if exists (debounce)
        if (compareTimeout) {
            clearTimeout(compareTimeout);
        }
        // Set a small delay to avoid spamming requests while user is clicking
        compareTimeout = window.setTimeout(() => {
            const base = baseBranchSelect.value;
            const head = headBranchSelect.value;

            // Only send if both branches are selected
            if (base && head && base !== head) {
                 // Show loading state in file list
                 if (filesChangedListDiv) filesChangedListDiv.innerHTML = '<p>Comparing branches...</p>';
                 if (filesChangedCountSpan) filesChangedCountSpan.textContent = '?';

                console.log(`Requesting comparison: ${base}...${head}`);
                vscode.postMessage({ command: 'compareBranches', base, head });
            } else if (base && head && base === head) {
                 // Handle case where base and head are the same
                 if (filesChangedListDiv) filesChangedListDiv.innerHTML = '<p>Base and Merge branches cannot be the same.</p>';
                 if (filesChangedCountSpan) filesChangedCountSpan.textContent = '0';
            }
        }, 500); // 500ms debounce delay
    }

    baseBranchSelect?.addEventListener('change', handleBranchChange);
    headBranchSelect?.addEventListener('change', handleBranchChange);

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

    function populateBranchDropdown(selectElement: HTMLSelectElement, branches: string[] | undefined, defaultSelection?: string) {
        if (!selectElement) return;
        // --- Store previously selected value before clearing ---
        const previousValue = selectElement.value;
        // --- End Store ---

        selectElement.innerHTML = '<option value="">Select branch...</option>';

        if (!branches || branches.length === 0) {
            selectElement.innerHTML = '<option value="">No branches found</option>';
            return;
        }

        branches.forEach(branch => {
            const option = document.createElement('option');
            option.value = branch;
            option.textContent = branch;
            // Select based on default OR previous selection if it still exists
            if (branch === defaultSelection || (previousValue && branch === previousValue && !defaultSelection)) {
                 option.selected = true;
            }
            selectElement.appendChild(option);
        });

         // Ensure a valid value is selected if the previous one disappeared
         if (!selectElement.value && branches.length > 0) {
            // If nothing is selected (e.g., previous value was removed),
            // try selecting the default again, or the first branch.
            if (defaultSelection && branches.includes(defaultSelection)) {
                selectElement.value = defaultSelection;
            } else {
               // selectElement.value = branches[0]; // Or leave as "Select branch..."
            }
         }
    }

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

        if (!filesChangedListDiv || !filesChangedCountSpan) {
            console.error("Files list container or count span not found in DOM.");
            return;
       }

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