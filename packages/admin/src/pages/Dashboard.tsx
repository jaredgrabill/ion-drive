import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Database, KeyRound, Shield, Users as UsersIcon } from 'lucide-react';
import { Badge, Card, CardContent, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

function StatCard({
  label,
  value,
  to,
  icon: Icon,
}: {
  label: string;
  value: number | string;
  to: string;
  icon: typeof Database;
}) {
  return (
    <Link to={to}>
      <Card className="transition-colors hover:border-ring">
        <CardContent className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="mt-1 text-2xl font-bold">{value}</p>
          </div>
          <Icon className="h-8 w-8 text-muted-foreground/50" />
        </CardContent>
      </Card>
    </Link>
  );
}

export function Dashboard() {
  const { roles } = useSession();
  const objects = useQuery({ queryKey: ['objects'], queryFn: () => api.listObjects() });
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.listUsers() });
  const rolesQ = useQuery({ queryKey: ['roles'], queryFn: () => api.listRoles() });
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: () => api.listApiKeys() });

  const userObjects = (objects.data ?? []).filter((o) => !o.isSystem);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Your roles:{' '}
          {roles.map((r) => (
            <Badge key={r} className="ml-1">
              {r}
            </Badge>
          ))}
        </p>
      </div>

      {objects.isLoading ? (
        <Spinner />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Data Objects" value={userObjects.length} to="/objects" icon={Database} />
          <StatCard label="Users" value={users.data?.length ?? '—'} to="/users" icon={UsersIcon} />
          <StatCard label="Roles" value={rolesQ.data?.length ?? '—'} to="/roles" icon={Shield} />
          <StatCard
            label="API Keys"
            value={keys.data?.length ?? '—'}
            to="/settings"
            icon={KeyRound}
          />
        </div>
      )}

      <Card className="mt-6">
        <CardContent>
          <h2 className="mb-3 font-semibold">Recent objects</h2>
          {userObjects.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No data objects yet.{' '}
              <Link to="/objects" className="underline">
                Create one
              </Link>
              .
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {userObjects.slice(0, 8).map((o) => (
                <li key={o.name} className="flex items-center justify-between py-2">
                  <Link
                    to="/objects/$name"
                    params={{ name: o.name }}
                    className="font-medium hover:underline"
                  >
                    {o.displayName}
                  </Link>
                  <span className="text-sm text-muted-foreground">{o.fieldCount} fields</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
