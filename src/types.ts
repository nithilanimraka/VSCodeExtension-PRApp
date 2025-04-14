// Define types for Git info we might need
export interface GitInfo {
    headBranch?: string;
    baseBranch?: string;
    remoteUrl?: string;
    owner?: string;
    repo?: string;
    changedFiles?: ChangedFile[]; 
    branches?: string[];
}

// type for changed files 
export interface ChangedFile {
    path: string;
    status: 'A' | 'M' | 'D' | 'R' | 'C' | '?'; // Added, Modified, Deleted, Renamed, Copied, Untracked/Unknown
}


// Define the shape of messages sent TO the webview
export type ToCreatePrWebviewMessage =
    | { command: 'loadFormData'; data: GitInfo }; 

// Define the shape of messages sent FROM the webview
export type FromCreatePrWebviewMessage =
    | { command: 'webviewReady' }
    | { command: 'createPrRequest'; data: { base: string; head: string; title: string; body: string; } }
    | { command: 'cancelPr' }
    | { command: 'getChangedFiles' } // Webview can request file list
    | { command: 'showError'; text: string }
    | { command: 'compareBranches'; base: string; head: string }
    | { command: 'showCreatePrDiff'; data: { base: string; head: string; filename: string; status: ChangedFile['status']; owner: string; repo: string } };


export type ComparisonFile = {
    sha: string;
    filename: string;
    // Status from compareCommits API
    status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
};

export interface VsCodeApi {
    postMessage(message: FromCreatePrWebviewMessage): void;
    getState(): any;
    setState(state: any): void;
}