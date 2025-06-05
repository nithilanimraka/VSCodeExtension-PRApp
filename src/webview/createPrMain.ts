import { ChangedFile, FromCreatePrWebviewMessage, ToCreatePrWebviewMessage, VsCodeApi } from '../types';

// --- Global variables for owner/repo ---
let currentOwner: string | undefined;
let currentRepo: string | undefined;
// ---------------------------------------

declare const acquireVsCodeApi: () => VsCodeApi;

(function () {
    const vscode = acquireVsCodeApi();

    // --- Get references to form elements ---
    const baseBranchSelect = document.getElementById('base-branch-select') as HTMLSelectElement;
    const headBranchSelect = document.getElementById('head-branch-select') as HTMLSelectElement;
    const titleInput = document.getElementById('pr-title') as HTMLInputElement;
    const descriptionTextarea = document.getElementById('pr-description') as HTMLTextAreaElement;
    const filesChangedListDiv = document.getElementById('files-changed-list');
    const filesChangedCountSpan = document.getElementById('files-changed-count');
    const codeReviewButton = document.getElementById('code-review-button') as HTMLButtonElement;
    const createButton = document.getElementById('create-button') as HTMLButtonElement;
    const cancelButton = document.getElementById('cancel-button') as HTMLButtonElement;

    let availableBranches: string[] | undefined = undefined;
    let compareTimeout: number | undefined;

    // --- Event Listeners ---
    window.addEventListener('message', (event: MessageEvent<ToCreatePrWebviewMessage>) => {
        const message = event.data;
        if (message.command === 'loadFormData') {
            console.log('Webview received loadFormData:', message.data);
            if (message.data?.owner && message.data?.repo) {
                currentOwner = message.data.owner;
                currentRepo = message.data.repo;
                console.log(`Stored owner: ${currentOwner}, repo: ${currentRepo}`);
            }

            const isInitialLoad = message.data?.branches !== undefined;

            if (isInitialLoad) {
                console.log("Processing initial load or full refresh.");
                if (titleInput) { titleInput.value = ''; }
                if (descriptionTextarea) { descriptionTextarea.value = ''; }

                availableBranches = message.data.branches || [];
                console.log("Populating branch dropdowns.");
                populateBranchDropdown(baseBranchSelect, availableBranches, message.data.baseBranch);
                populateBranchDropdown(headBranchSelect, availableBranches, message.data.headBranch);

                if (titleInput && !titleInput.value && message.data.headBranch) {
                    titleInput.value = formatBranchNameAsTitle(message.data.headBranch);
                }

                if (baseBranchSelect.value && headBranchSelect.value && baseBranchSelect.value !== headBranchSelect.value) {
                    triggerComparison();
                } else {
                    renderFileList(filesChangedListDiv, filesChangedCountSpan, []);
                }
            } else {
                 console.log("Processing changed files update.");
                 if (message.data?.changedFiles !== undefined) {
                     console.log("Updating file list from message.");
                     renderFileList(filesChangedListDiv, filesChangedCountSpan, message.data.changedFiles || []);
                 }
            }
            updateButtonStates();
        }
         // Listen for reviewFinished message to re-enable button
         else if (message.command === 'reviewFinished') {
             if (codeReviewButton) {
                 codeReviewButton.disabled = false;
                 codeReviewButton.textContent = 'Code Review';
             }
        }
    });

    function triggerComparison() {
        const base = baseBranchSelect.value;
        const head = headBranchSelect.value;
        if (base && head && base !== head) {
            if (filesChangedListDiv) { filesChangedListDiv.innerHTML = '<p>Comparing branches...</p>'; }
            if (filesChangedCountSpan) { filesChangedCountSpan.textContent = '?'; }
            console.log(`Requesting comparison: ${base}...${head}`);
            const message: FromCreatePrWebviewMessage = { command: 'compareBranches', base, head };
            vscode.postMessage(message);
        } else if (base && head && base === head) {
            if (filesChangedListDiv) { filesChangedListDiv.innerHTML = '<p>Base and Merge branches cannot be the same.</p>'; }
            if (filesChangedCountSpan) { filesChangedCountSpan.textContent = '0'; }
            renderFileList(filesChangedListDiv, filesChangedCountSpan, []);
        } else {
            if (filesChangedListDiv) { filesChangedListDiv.innerHTML = '<p>Select branches to compare...</p>'; }
            if (filesChangedCountSpan) { filesChangedCountSpan.textContent = '0'; }
            renderFileList(filesChangedListDiv, filesChangedCountSpan, []);
        }
         updateButtonStates();
    }

    function handleBranchChange() {
        if (compareTimeout) { clearTimeout(compareTimeout); }
        updateButtonStates();
        const base = baseBranchSelect.value;
        const head = headBranchSelect.value;
        if (base && head && base !== head) {
            compareTimeout = window.setTimeout(triggerComparison, 500);
        } else {
             if (filesChangedListDiv) {
                 const messageText = (base && head && base === head) ? 'Base and Merge branches cannot be the same.' : 'Select branches to compare...';
                 filesChangedListDiv.innerHTML = `<p>${messageText}</p>`;
             }
             if (filesChangedCountSpan) { filesChangedCountSpan.textContent = '0'; }
             renderFileList(filesChangedListDiv, filesChangedCountSpan, []);
        }
    }

    baseBranchSelect?.addEventListener('change', handleBranchChange);
    headBranchSelect?.addEventListener('change', handleBranchChange);
    titleInput?.addEventListener('input', updateButtonStates);

    function updateButtonStates() {
        const base = baseBranchSelect?.value;
        const head = headBranchSelect?.value;
        const title = titleInput?.value;
        const branchesSelectedAndDifferent = base && head && base !== head;
        if (createButton) {
            createButton.disabled = !branchesSelectedAndDifferent || !title;
        }
        if (codeReviewButton) {
            // Keep button enabled only if branches are different
            codeReviewButton.disabled = !branchesSelectedAndDifferent;
        }
    }

    createButton?.addEventListener('click', (e) => {
        e.preventDefault();
        if (createButton.disabled) { console.warn("Create button clicked while disabled."); return; }
        const base = baseBranchSelect.value;
        const head = headBranchSelect.value;
        const title = titleInput.value;
        const body = descriptionTextarea.value;
        const message: FromCreatePrWebviewMessage = { command: 'createPrRequest', data: { base, head, title, body } };
        vscode.postMessage(message);
    });

    codeReviewButton?.addEventListener('click', async () => {
        if (codeReviewButton.disabled || !baseBranchSelect || !headBranchSelect) { return; }
        const base = baseBranchSelect.value;
        const head = headBranchSelect.value;
        if (!base || !head || base === head) {
             vscode.postMessage({ command: 'showError', text: 'Please select two different branches to request a code review.' });
             return;
        }
        console.log(`Code Review button clicked for: ${base}...${head}`);
        codeReviewButton.disabled = true;
        codeReviewButton.textContent = 'Reviewing...'; // Provide visual feedback
        const message: FromCreatePrWebviewMessage = { command: 'submitCodeReview', data: { base, head } };
        vscode.postMessage(message);
        // Note: Button is re-enabled by 'reviewFinished' message from extension host now
    });

    cancelButton?.addEventListener('click', () => {
        console.log("Cancel button clicked");
        const message: FromCreatePrWebviewMessage = { command: 'cancelPr' };
        vscode.postMessage(message);
    });

    // --- Helper Functions --- (keep getCodiconNameForFile, populateBranchDropdown, formatBranchNameAsTitle, renderFileList)
    function getCodiconNameForFile(filename: string): string {
        const lowerFilename = filename.toLowerCase();
        if (lowerFilename.endsWith('.py')) { return 'codicon-file-code'; }
        if (lowerFilename.endsWith('.js')) { return 'codicon-file-code'; }
        if (lowerFilename.endsWith('.ts')) { return 'codicon-file-code'; }
        if (lowerFilename.endsWith('.java')) { return 'codicon-file-code'; }
        if (lowerFilename.endsWith('.cs')) { return 'codicon-file-code'; }
        if (lowerFilename.endsWith('.html')) { return 'codicon-file-code'; }
        if (lowerFilename.endsWith('.css')) { return 'codicon-file-code'; }
        if (lowerFilename.endsWith('.json')) { return 'codicon-json'; }
        if (lowerFilename.endsWith('.md')) { return 'codicon-markdown'; }
        if (lowerFilename.endsWith('.txt')) { return 'codicon-file-text'; }
        if (lowerFilename.includes('requirements')) { return 'codicon-checklist'; }
        if (lowerFilename.includes('dockerfile')) { return 'codicon-docker'; }
        if (lowerFilename.includes('config') || lowerFilename.endsWith('.yml') || lowerFilename.endsWith('.yaml')) { return 'codicon-settings-gear'; }
        if (lowerFilename.endsWith('.git') || lowerFilename.includes('gitignore') || lowerFilename.includes('gitattributes')) { return 'codicon-git-commit'; }
        if (lowerFilename.endsWith('.png') || lowerFilename.endsWith('.jpg') || lowerFilename.endsWith('.jpeg') || lowerFilename.endsWith('.gif') || lowerFilename.endsWith('.svg')) { return 'codicon-file-media'; }
        return 'codicon-file';
    }

    function populateBranchDropdown(selectElement: HTMLSelectElement | null, branches: string[], defaultSelection?: string) {
        if (!selectElement) { return; }
        const previousValue = selectElement.value;
        selectElement.innerHTML = '<option value="">Select branch...</option>';

        if (branches.length === 0) {
            selectElement.innerHTML = '<option value="">No branches found</option>';
            selectElement.disabled = true;
            return;
        }
        selectElement.disabled = false;

        let foundPreviousValue = false;
        let foundDefaultSelection = false;

        branches.forEach(branch => {
            const option = document.createElement('option');
            option.value = branch;
            option.textContent = branch;
            selectElement.appendChild(option);
            if (branch === previousValue) { foundPreviousValue = true; }
            if (branch === defaultSelection) { foundDefaultSelection = true; }
        });

        if (foundPreviousValue) {
            selectElement.value = previousValue;
        } else if (foundDefaultSelection) {
            selectElement.value = defaultSelection!;
        }
    }

    function formatBranchNameAsTitle(branchName: string): string {
        return branchName
            .replace(/[-_]/g, ' ')
            .replace(/\b\w/g, char => char.toUpperCase());
    }

    function renderFileList(listDiv: HTMLElement | null, countSpan: HTMLElement | null, files: ChangedFile[]) {
        if (!listDiv || !countSpan) {
            console.warn("File list container or count span not found for rendering.");
            return;
        }
        console.log(`Rendering ${files.length} files into:`, listDiv.id);

        listDiv.innerHTML = '';
        countSpan.textContent = String(files.length);

        if (files.length === 0) {
            const base = baseBranchSelect?.value;
            const head = headBranchSelect?.value;
            const messageText = (base && head && base !== head) ? 'No changes detected between selected branches.' : 'Select branches to compare...';
            listDiv.innerHTML = `<p>${messageText}</p>`;
            return;
        }

        const ul = document.createElement('ul');
        ul.className = 'file-list-ul';

        files.forEach(file => {
            const li = document.createElement('li');
            const status = file.status || '?';
            li.className = `file-list-item status-${status.toLowerCase()} clickable-file`;
            li.dataset.filename = file.path;
            li.dataset.status = status;
            li.tabIndex = 0;
            li.role = 'button';
            li.title = `Click to view changes for ${file.path}`;

            const iconSpan = document.createElement('span');
            const iconName = getCodiconNameForFile(file.path || '');
            iconSpan.className = `codicon ${iconName} file-icon`;

            const pathSpan = document.createElement('span');
            pathSpan.textContent = file.path?.split(/[\\/]/).pop() || file.path || 'Unknown path';
            pathSpan.title = file.path || '';
            pathSpan.className = 'file-path';

            const statusSpan = document.createElement('span');
            statusSpan.className = `file-status file-status-${status.toLowerCase()}`;
            statusSpan.textContent = status;

            li.appendChild(iconSpan);
            li.appendChild(pathSpan);
            li.appendChild(statusSpan);
            ul.appendChild(li);
        });
        listDiv.appendChild(ul);
    }

    filesChangedListDiv?.addEventListener('click', (event) => {
        const target = event.target as HTMLElement;
        const listItem = target.closest<HTMLLIElement>('li.clickable-file');

        if (listItem && listItem.dataset.filename && listItem.dataset.status && currentOwner && currentRepo) {
            const filename = listItem.dataset.filename;
            const status = listItem.dataset.status as ChangedFile['status'];
            const base = baseBranchSelect?.value;
            const head = headBranchSelect?.value;

            if (!base || !head || base === head) {
                const errorMsg: FromCreatePrWebviewMessage = { command: 'showError', text: 'Please select two different branches to view diff.'};
                vscode.postMessage(errorMsg);
                return;
            }
            console.log(`File clicked: ${filename}, Status: ${status}, Base: ${base}, Head: ${head}`);
            const message: FromCreatePrWebviewMessage = {
                command: 'showCreatePrDiff',
                data: {
                    base: base, head: head, filename: filename, status: status,
                    owner: currentOwner, repo: currentRepo
                }
            };
            vscode.postMessage(message);
        }
    });

    filesChangedListDiv?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            const target = event.target as HTMLElement;
            if (target.matches('li.clickable-file')) {
                event.preventDefault();
                target.click();
            }
        }
    });

    // --- Initialization ---
    console.log("Create PR webview script initialized.");
    const readyMessage: FromCreatePrWebviewMessage = { command: 'webviewReady' };
    vscode.postMessage(readyMessage);
    updateButtonStates();

}());