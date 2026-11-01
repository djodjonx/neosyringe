import { useInterface } from '@djodjonx/neosyringe';
import type { Repo, User } from './types';

export const UserToken = useInterface<User>();
export const UserRepoToken = useInterface<Repo<User>>();
