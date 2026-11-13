import * as vscode from 'vscode';
import { REVEAL_TEXT_SCHEME, RevealTextDocumentContentProvider, RevealTextRefusal,
  type RevealTextReadPort, type RevealTextReferenceInput } from './provider';

/** Owns the native registration and explicit user-action lifecycle. */
export class RevealTextDocuments implements vscode.Disposable {
  readonly #provider: RevealTextDocumentContentProvider;
  readonly #registration: vscode.Disposable;
  #disposed = false;
  #opening = false;

  public constructor(source: RevealTextReadPort) {
    this.#provider = new RevealTextDocumentContentProvider(source);
    this.#registration = vscode.workspace.registerTextDocumentContentProvider(REVEAL_TEXT_SCHEME, this.#provider);
  }

  public async open(input: RevealTextReferenceInput, isCurrent: () => boolean): Promise<boolean> {
    if (this.#disposed || this.#opening || !isCurrent()) return false;
    this.#opening = true;
    let uri: vscode.Uri | undefined;
    try {
      uri = this.#provider.register(input);
      const document = await vscode.workspace.openTextDocument(uri);
      if (this.#disposed || !isCurrent()) {
        this.#provider.release(uri);
        return false;
      }
      await vscode.window.showTextDocument(document, { preview: true });
      return true;
    } catch (error) {
      if (uri !== undefined) this.#provider.release(uri);
      if (!this.#disposed && isCurrent()) {
        const message = error instanceof RevealTextRefusal ? error.message : 'The complete read-only record could not be opened.';
        void vscode.window.showWarningMessage(message);
      }
      return false;
    } finally {
      this.#opening = false;
    }
  }

  public dispose(): void {
    this.#disposed = true;
    this.#registration.dispose();
    this.#provider.dispose();
  }
}
