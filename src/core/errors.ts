export class RepoKnowledgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoKnowledgeError";
  }
}

export class NotInitializedError extends RepoKnowledgeError {
  constructor(projectRoot: string) {
    super(
      `No .repo-knowledge directory found in ${projectRoot}. Run 'repo-knowledge init' first.`,
    );
    this.name = "NotInitializedError";
  }
}

export class AlreadyInitializedError extends RepoKnowledgeError {
  constructor(projectRoot: string) {
    super(`Project already initialized at ${projectRoot}`);
    this.name = "AlreadyInitializedError";
  }
}

export class IndexNotFoundError extends RepoKnowledgeError {
  constructor() {
    super("No index found. Run 'repo-knowledge index' first.");
    this.name = "IndexNotFoundError";
  }
}

export class UnsupportedLanguageError extends RepoKnowledgeError {
  constructor(language: string) {
    super(`Unsupported language: ${language}`);
    this.name = "UnsupportedLanguageError";
  }
}
