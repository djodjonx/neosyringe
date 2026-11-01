export interface User {
  id: string;
}

export interface Repo<T> {
  get(): T;
}

export interface Other {
  n: number;
}
