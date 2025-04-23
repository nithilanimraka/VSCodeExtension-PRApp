// src/gitUtils.ts
import * as vscode from 'vscode';

// Get the Git API
export async function getGitApi() {
    try {
        const extension = vscode.extensions.getExtension('vscode.git');
        if (!extension) {
            // Don't show error message here, let caller decide
            console.warn('Git extension (vscode.git) not found.');
            return undefined;
        }

        if (!extension.isActive) {
            await extension.activate();
        }

        const api = extension.exports.getAPI(1);
        // Check if repositories array exists and has items
        if (!api || !api.repositories || api.repositories.length === 0) {
            // Don't show warning here, let caller decide
            console.warn("No Git repositories found or Git API not ready.");
            return undefined;
        }
        return api; // Return the API object

    } catch (error) {
        console.error("Failed to get Git API:", error);
        // Don't show error message here, let caller decide
        return undefined;
    }
}

// Helper to check if a Git repo is initialized in the workspace
export async function isGitRepositoryAvailable(): Promise<boolean> {
    const api = await getGitApi();
    return !!api; // True if api is truthy (exists and has repos), false otherwise
}

// Helper to get the repository path (optional, might be useful later)
export async function getCurrentRepositoryPath(): Promise<string | undefined> {
    const api = await getGitApi();
    if (api && api.repositories.length > 0) {
        return api.repositories[0].rootUri.fsPath;
    }
    return undefined;
}