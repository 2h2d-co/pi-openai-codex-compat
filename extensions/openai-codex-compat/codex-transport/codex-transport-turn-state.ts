export class CodexTurnState {
  #value: string | undefined;
  #revision = 0;

  get available(): boolean {
    return this.#value !== undefined;
  }

  get revision(): number {
    return this.#revision;
  }

  replayValue(): string | undefined {
    return this.#value;
  }

  capture(value: string | undefined): boolean {
    if (this.#value !== undefined || !value) return false;
    this.#value = value;
    this.#revision += 1;
    return true;
  }
}
