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

    const formElement = document.querySelector('.create-pr-form') as HTMLElement | null; // Get form container

    // --- Store the branches list locally ---
    let availableBranches: string[] | undefined = undefined;

    // --- Event Listeners ---

    // Listen for messages from the extension host
    window.addEventListener('message', (event: MessageEvent<ToCreatePrWebviewMessage>) => {
        const message = event.data;
        if (message.command === 'loadFormData') {
            
            console.log('Webview received form data:', message.data);
            // --- ALWAYS Ensure form is visible when data arrives ---
           showWaitingState(false);

           // Clear Title and Description before applying new data (handles reset case too)
           if (titleInput) titleInput.value = '';
           if (descriptionTextarea) descriptionTextarea.value = '';

            // ONLY populate branches if the message actually contains them
            if (message.data?.branches !== undefined) { // Add null check for message.data
                availableBranches = message.data.branches; // Store the branches
                console.log("Populating branch dropdowns.");
                populateBranchDropdown(baseBranchSelect, availableBranches, message.data.baseBranch);
                populateBranchDropdown(headBranchSelect, availableBranches, message.data.headBranch);
            } else if (message.data) { // Only clear if message.data exists but branches doesn't
                 // If branches array is missing, clear the dropdowns
                 console.log("Branches data missing, clearing dropdowns.");
                 populateBranchDropdown(baseBranchSelect, []);
                 populateBranchDropdown(headBranchSelect, []);
            }


            // Set title if applicable (can happen on initial load)
             // Add null check for message.data
            if (message.data?.branches !== undefined && titleInput && !titleInput.value && message.data.headBranch) {
                titleInput.value = formatBranchNameAsTitle(message.data.headBranch);
            }

            // Update files list if present in the message
            if(message.data?.changedFiles !== undefined) { // Add null check for message.data
                console.log("Updating file list.");
                renderFileList(message.data.changedFiles || []);
            // } else if (message.data?.branches !== undefined) { // Original condition, maybe too broad
            } else if (message.data) { // If data exists but changedFiles doesn't
                 // If changedFiles is missing, clear/reset file list
                 console.log("Changed files data missing, resetting file list.");
                 renderFileList([]); // Render empty state
            } else {
                 // If message.data itself is missing/null, render empty file list
                 renderFileList([]);
            }
        }
    });

    function showWaitingState(show: boolean) {
        if (formElement) {
            const waitingMsgId = 'waiting-message'; // Define ID
            let waitingMsg = document.getElementById(waitingMsgId);

            if (show) {
                // Hide form elements, show a message
                formElement.style.display = 'none';
                // Create/show a waiting message element if it doesn't exist
                if (!waitingMsg) {
                    waitingMsg = document.createElement('p');
                    waitingMsg.id = waitingMsgId; // Use defined ID
                    waitingMsg.textContent = "Open a GitHub repository and use the 'Create Pull Request' action from the PR list view.";
                    waitingMsg.style.padding = '15px';
                    waitingMsg.style.textAlign = 'center';
                    // Insert before form OR append to body if form isn't found initially
                    document.body.insertBefore(waitingMsg, formElement.nextSibling); // Insert after form if possible
                }
                waitingMsg.style.display = 'block'; // Ensure it's visible
            } else {
                // Show form elements, hide waiting message
                formElement.style.display = 'flex'; // Use 'flex' as per your CSS
                if (waitingMsg) {
                    waitingMsg.style.display = 'none'; // Hide the waiting message
                }
            }
        } else {
            // Handle case where form element isn't found initially
            console.warn("'.create-pr-form' element not found during showWaitingState call.");
            // You might want to ensure the waiting message is still handled correctly
            const waitingMsgId = 'waiting-message';
            let waitingMsg = document.getElementById(waitingMsgId);
             if (show && !waitingMsg) {
                waitingMsg = document.createElement('p');
                waitingMsg.id = waitingMsgId;
                waitingMsg.textContent = "Loading Create Pull Request form..."; // More appropriate initial message?
                waitingMsg.style.padding = '15px';
                waitingMsg.style.textAlign = 'center';
                document.body.appendChild(waitingMsg); // Append to body as fallback
             } else if (waitingMsg) {
                 waitingMsg.style.display = show ? 'block' : 'none';
             }
        }
    }

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
        const title = titleInput.value;
        const body = descriptionTextarea.value;

        // Add validation for selected branch values
        if (!base || !head || !title) {
            console.error("Missing required fields (base, head, title)");
             vscode.postMessage({ command: 'showError', text: 'Please select base/head branches and enter a title.' }); // Example: Tell extension to show error
            return;
        }

        if (base === head) {
            console.error("Base and head branches are the same.");
            vscode.postMessage({ command: 'showError', text: 'Base and Merge branches cannot be the same.' });
           return;
       }

        vscode.postMessage({
            command: 'createPrRequest',
            data: { base, head, title, body }
        });
    });

    // Handle Cancel button click
    cancelButton?.addEventListener('click', () => {
        console.log("Cancel button clicked");
        // Tell extension host we cancelled
        vscode.postMessage({ command: 'cancelPr' });
        // Show waiting state immediately in UI for faster feedback
        showWaitingState(true);
    });

    // --- NEW: Helper Function to get Codicon class based on filename ---
    function getCodiconNameForFile(filename: string): string {
        const lowerFilename = filename.toLowerCase();
        // Use more semantic codicons where available
        if (lowerFilename.endsWith('.py')) return 'codicon-file-code'; // General code icon
        if (lowerFilename.endsWith('.js')) return 'codicon-file-code';
        if (lowerFilename.endsWith('.ts')) return 'codicon-file-code';
        if (lowerFilename.endsWith('.java')) return 'codicon-file-code';
        if (lowerFilename.endsWith('.cs')) return 'codicon-file-code';
        if (lowerFilename.endsWith('.html')) return 'codicon-file-code'; // Or 'codicon-globe' maybe?
        if (lowerFilename.endsWith('.css')) return 'codicon-file-code'; // Or 'codicon-paintcan'?
        if (lowerFilename.endsWith('.json')) return 'codicon-json';
        if (lowerFilename.endsWith('.md')) return 'codicon-markdown';
        if (lowerFilename.endsWith('.txt')) return 'codicon-file-text';
        if (lowerFilename.includes('requirements')) return 'codicon-checklist'; // Checklist icon seems appropriate
        if (lowerFilename.includes('dockerfile')) return 'codicon-docker';
        if (lowerFilename.includes('config') || lowerFilename.endsWith('.yml') || lowerFilename.endsWith('.yaml')) return 'codicon-settings-gear'; // Gear icon
        if (lowerFilename.endsWith('.git') || lowerFilename.includes('gitignore') || lowerFilename.includes('gitattributes')) return 'codicon-git-commit'; // Git icon
        if (lowerFilename.endsWith('.png') || lowerFilename.endsWith('.jpg') || lowerFilename.endsWith('.jpeg') || lowerFilename.endsWith('.gif') || lowerFilename.endsWith('.svg')) return 'codicon-file-media'; // Media icon

        // Default icon
        return 'codicon-file';
    }


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
        if (!filesChangedListDiv || !filesChangedCountSpan) { /* ... error handling ... */ return; }
        console.log(`Rendering ${files.length} files...`, files);
    
        filesChangedListDiv.innerHTML = '';
        filesChangedCountSpan.textContent = String(files.length);
    
        if (files.length === 0) {
            filesChangedListDiv.innerHTML = '<p>No changes detected.</p>';
            return;
        }
    
        const ul = document.createElement('ul');
        ul.className = 'file-list-ul';
    
        files.forEach(file => {
            const li = document.createElement('li');
            const status = file.status || '?';
            // --- Add status class to the list item ---
            li.className = `file-list-item status-${status.toLowerCase()}`;
            // --- End Add ---
    
            // Icon Span
            const iconSpan = document.createElement('span');
            const iconName = getCodiconNameForFile(file.path || '');
            iconSpan.className = `codicon ${iconName} file-icon`;
    
            // File Path Span
            const pathSpan = document.createElement('span');
            pathSpan.textContent = file.path?.split(/[\\/]/).pop() || file.path || 'Unknown path';
            pathSpan.title = file.path || '';
            pathSpan.className = 'file-path'; // Keep this class
    
            // Status Span
            const statusSpan = document.createElement('span');
            statusSpan.className = `file-status file-status-${status.toLowerCase()}`;
            statusSpan.textContent = status;
    
            li.appendChild(iconSpan);
            li.appendChild(pathSpan);
            li.appendChild(statusSpan);
            ul.appendChild(li);
        });
        filesChangedListDiv.appendChild(ul);
    }

    // Initial state on load - Keep showing waiting initially is fine
    // Or maybe hide both initially until first message?
    // showWaitingState(true); // Show waiting message initially
    if(formElement) formElement.style.display = 'none'; // Hide form initially
    const waitingMsg = document.getElementById('waiting-message');
    if(waitingMsg) waitingMsg.style.display = 'block'; // Show waiting message


    // --- Initialization ---
    console.log("Create PR webview script initialized.");
    vscode.postMessage({ command: 'webviewReady' });
    // Optional: Request initial file list immediately if needed
    // vscode.postMessage({ command: 'getChangedFiles' });

}());