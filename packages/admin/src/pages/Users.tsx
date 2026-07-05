import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Card, CardContent, Select, Spinner } from '../components/ui';
import { api } from '../lib/api';

export function Users() {
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.listUsers() });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.listRoles() });

  const assign = useMutation({
    mutationFn: ({ roleId, userId }: { roleId: string; userId: string }) =>
      api.assignRole(roleId, userId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });
  const unassign = useMutation({
    mutationFn: ({ roleId, userId }: { roleId: string; userId: string }) =>
      api.unassignRole(roleId, userId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });

  if (users.isLoading) return <Spinner />;

  const roleByName = new Map((roles.data ?? []).map((r) => [r.name, r.id]));

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Users</h1>
        <p className="text-sm text-muted-foreground">
          Accounts are managed by the auth provider; assign roles here.
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">User</th>
                <th className="px-4 py-2 font-medium">Roles</th>
                <th className="px-4 py-2 font-medium">Add role</th>
              </tr>
            </thead>
            <tbody>
              {(users.data ?? []).map((u) => (
                <tr key={u.id} className="border-b border-border/60">
                  <td className="px-4 py-3">
                    <div className="font-medium">{u.name || u.email}</div>
                    <div className="text-xs text-muted-foreground">{u.email}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {u.roles.length === 0 && (
                        <span className="text-xs text-muted-foreground">none</span>
                      )}
                      {u.roles.map((r) => (
                        <button
                          key={r}
                          type="button"
                          title="Click to remove"
                          onClick={() => {
                            const roleId = roleByName.get(r);
                            if (roleId && confirm(`Remove role "${r}" from ${u.email}?`)) {
                              unassign.mutate({ roleId, userId: u.id });
                            }
                          }}
                        >
                          <Badge
                            variant="secondary"
                            className="cursor-pointer hover:bg-destructive/15"
                          >
                            {r} ✕
                          </Badge>
                        </button>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Select
                      className="w-40"
                      value=""
                      onChange={(e) => {
                        if (e.target.value) assign.mutate({ roleId: e.target.value, userId: u.id });
                      }}
                    >
                      <option value="">Add role…</option>
                      {(roles.data ?? [])
                        .filter((r) => !u.roles.includes(r.name))
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
      {(users.data ?? []).length === 0 && (
        <p className="mt-4 text-sm text-muted-foreground">No users yet.</p>
      )}
    </div>
  );
}
