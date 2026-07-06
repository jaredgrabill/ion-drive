/**
 * Users — account list with role assignment.
 *
 * Accounts are managed by the auth provider; this page assigns/unassigns
 * roles. Removing a role goes through an AlertDialog; all mutations toast
 * their outcome.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useState } from 'react';
import {
  AlertDialog,
  Avatar,
  Badge,
  Card,
  CardContent,
  EmptyState,
  Select,
  Skeleton,
  toast,
} from '../components/ui';
import { ApiError, api } from '../lib/api';

export function Users() {
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.listUsers() });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.listRoles() });
  const [removing, setRemoving] = useState<{ role: string; userId: string; email: string } | null>(
    null,
  );

  const assign = useMutation({
    mutationFn: ({ roleId, userId }: { roleId: string; userId: string }) =>
      api.assignRole(roleId, userId),
    onSuccess: () => {
      toast.success('Role assigned');
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (error) =>
      toast.error(
        `Failed to assign: ${error instanceof ApiError ? error.message : 'unexpected error'}`,
      ),
  });
  const unassign = useMutation({
    mutationFn: ({ roleId, userId }: { roleId: string; userId: string }) =>
      api.unassignRole(roleId, userId),
    onSuccess: () => {
      toast.success('Role removed');
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (error) =>
      toast.error(
        `Failed to remove: ${error instanceof ApiError ? error.message : 'unexpected error'}`,
      ),
  });

  const roleByName = new Map((roles.data ?? []).map((r) => [r.name, r.id]));

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Users</h1>
        <p className="text-sm text-muted-foreground">
          Accounts are managed by the auth provider; assign roles here.
        </p>
      </div>

      {users.isLoading ? (
        <Skeleton className="h-48 w-full" aria-hidden />
      ) : (users.data ?? []).length === 0 ? (
        <EmptyState title="No users yet" hint="The first account to sign up becomes an admin." />
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">
                    User
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Roles
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Add role
                  </th>
                </tr>
              </thead>
              <tbody>
                {(users.data ?? []).map((user) => (
                  <tr key={user.id} className="border-b border-border/60 last:border-0">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <Avatar name={user.name || user.email} />
                        <div>
                          <div className="font-medium">{user.name || user.email}</div>
                          <div className="text-xs text-muted-foreground">{user.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {user.roles.length === 0 && (
                          <span className="text-xs text-muted-foreground">none</span>
                        )}
                        {user.roles.map((role) => (
                          <Badge key={role} variant="secondary" className="gap-1 pr-1">
                            {role}
                            <button
                              type="button"
                              aria-label={`Remove role ${role} from ${user.email}`}
                              className="rounded-full p-0.5 hover:bg-destructive/20 hover:text-destructive"
                              onClick={() =>
                                setRemoving({ role, userId: user.id, email: user.email })
                              }
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Select
                        className="w-40"
                        value=""
                        aria-label={`Add role to ${user.email}`}
                        onChange={(e) => {
                          if (e.target.value)
                            assign.mutate({ roleId: e.target.value, userId: user.id });
                        }}
                      >
                        <option value="">Add role…</option>
                        {(roles.data ?? [])
                          .filter((r) => !user.roles.includes(r.name))
                          .map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <AlertDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="Remove role"
        description={`Remove role "${removing?.role ?? ''}" from ${removing?.email ?? ''}?`}
        confirmLabel="Remove"
        confirmVariant="destructive"
        onConfirm={() => {
          const roleId = removing ? roleByName.get(removing.role) : undefined;
          if (removing && roleId) unassign.mutate({ roleId, userId: removing.userId });
        }}
      />
    </div>
  );
}
Users.displayName = 'Users';
