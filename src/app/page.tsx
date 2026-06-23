"use client";

import { useEffect, useState } from "react";

const API_BASE = "http://localhost:5000";

interface User {
  uid: string;
  name: string;
  email: string;
  mobile: string | null;
  plan: string;
  createdAt: string | null;
  lastLogin: string | null;
  trialExpiresAt: string | null;
  planExpiresAt: string | null;
}

interface Stats {
  total: number;
  active: number;
  trial: number;
  expired: number;
}

interface LogEntry {
  id: string;
  userId: string;
  event: string;
  data: Record<string, unknown>;
  timestamp: string | null;
}

type Tab = "dashboard" | "users" | "logs";

export default function AdminPanel() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [stats, setStats] = useState<Stats>({ total: 0, active: 0, trial: 0, expired: 0 });
  const [users, setUsers] = useState<User[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadStats();
  }, []);

  useEffect(() => {
    if (tab === "users") loadUsers();
    if (tab === "logs") loadLogs();
  }, [tab, filter]);

  async function loadStats() {
    try {
      const res = await fetch(`${API_BASE}/api/admin/stats`);
      const data = await res.json();
      setStats(data);
    } catch (err) {
      console.error("Failed to load stats:", err);
    }
  }

  async function loadUsers() {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/users?plan=${filter}`);
      const data = await res.json();
      setUsers(data.users || []);
    } catch (err) {
      console.error("Failed to load users:", err);
    }
    setLoading(false);
  }

  async function loadLogs() {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/logs?limit=100`);
      const data = await res.json();
      setLogs(data.logs || []);
    } catch (err) {
      console.error("Failed to load logs:", err);
    }
    setLoading(false);
  }

  async function updateUserPlan(uid: string, plan: string, days: number) {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);

    try {
      await fetch(`${API_BASE}/api/admin/users/${uid}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, planExpiresAt: expiresAt.toISOString() }),
      });
      loadUsers();
      loadStats();
    } catch (err) {
      console.error("Failed to update user:", err);
    }
  }

  return (
    <div className="min-h-screen">
      {/* Navbar */}
      <nav className="bg-gray-800 border-b border-gray-700">
        <div className="max-w-7xl mx-auto px-6 flex justify-between h-16 items-center">
          <span className="text-xl font-bold text-blue-400">Label Manager Admin</span>
          <div className="flex gap-4">
            <button onClick={() => setTab("dashboard")} className={`text-sm font-medium ${tab === "dashboard" ? "text-blue-400" : "text-gray-400 hover:text-white"}`}>Dashboard</button>
            <button onClick={() => setTab("users")} className={`text-sm font-medium ${tab === "users" ? "text-blue-400" : "text-gray-400 hover:text-white"}`}>Users</button>
            <button onClick={() => setTab("logs")} className={`text-sm font-medium ${tab === "logs" ? "text-blue-400" : "text-gray-400 hover:text-white"}`}>Activity Logs</button>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto py-8 px-6">
        {/* Dashboard Tab */}
        {tab === "dashboard" && (
          <div>
            <h1 className="text-2xl font-bold mb-6">Dashboard</h1>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
              <StatCard label="Total Users" value={stats.total} />
              <StatCard label="Active Plans" value={stats.active} color="text-green-400" />
              <StatCard label="Trial Users" value={stats.trial} color="text-yellow-400" />
              <StatCard label="Expired" value={stats.expired} color="text-red-400" />
            </div>
          </div>
        )}

        {/* Users Tab */}
        {tab === "users" && (
          <div>
            <div className="flex justify-between items-center mb-6">
              <h1 className="text-2xl font-bold">Users</h1>
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm"
              >
                <option value="all">All Users</option>
                <option value="active">Active</option>
                <option value="trial">Trial</option>
                <option value="expired">Expired</option>
              </select>
            </div>

            {loading ? (
              <p className="text-gray-400">Loading...</p>
            ) : (
              <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
                <table className="min-w-full divide-y divide-gray-700">
                  <thead className="bg-gray-900/50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Name</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Email</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Plan</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Last Login</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-700">
                    {users.map((user) => (
                      <tr key={user.uid}>
                        <td className="px-6 py-4 text-sm font-medium">{user.name}</td>
                        <td className="px-6 py-4 text-sm text-gray-400">{user.email}</td>
                        <td className="px-6 py-4">
                          <PlanBadge plan={user.plan} />
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-400">
                          {user.lastLogin ? new Date(user.lastLogin).toLocaleDateString() : "Never"}
                        </td>
                        <td className="px-6 py-4 text-sm">
                          {user.plan !== "active" && (
                            <button
                              onClick={() => updateUserPlan(user.uid, "active", 30)}
                              className="text-blue-400 hover:text-blue-300 text-xs font-medium"
                            >
                              Activate 30d
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {users.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-6 py-8 text-center text-gray-500">No users found</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Logs Tab */}
        {tab === "logs" && (
          <div>
            <h1 className="text-2xl font-bold mb-6">Activity Logs</h1>
            {loading ? (
              <p className="text-gray-400">Loading...</p>
            ) : (
              <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
                <table className="min-w-full divide-y divide-gray-700">
                  <thead className="bg-gray-900/50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">User ID</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Event</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Time</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-700">
                    {logs.map((log) => (
                      <tr key={log.id}>
                        <td className="px-6 py-4 text-sm font-mono text-gray-400">{log.userId?.substring(0, 12)}...</td>
                        <td className="px-6 py-4 text-sm">
                          <EventBadge event={log.event} />
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-400">
                          {log.timestamp ? new Date(log.timestamp).toLocaleString() : "-"}
                        </td>
                      </tr>
                    ))}
                    {logs.length === 0 && (
                      <tr>
                        <td colSpan={3} className="px-6 py-8 text-center text-gray-500">No activity logs</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function StatCard({ label, value, color = "text-white" }: { label: string; value: number; color?: string }) {
  return (
    <div className="bg-gray-800 rounded-xl border border-gray-700 p-6">
      <dt className="text-sm font-medium text-gray-400">{label}</dt>
      <dd className={`mt-2 text-3xl font-semibold ${color}`}>{value}</dd>
    </div>
  );
}

function PlanBadge({ plan }: { plan: string }) {
  const styles: Record<string, string> = {
    active: "bg-green-900/30 text-green-400",
    trial: "bg-yellow-900/30 text-yellow-400",
    expired: "bg-red-900/30 text-red-400",
  };
  return (
    <span className={`px-2 py-1 text-xs font-semibold rounded-full ${styles[plan] || "bg-gray-700 text-gray-300"}`}>
      {plan}
    </span>
  );
}

function EventBadge({ event }: { event: string }) {
  const styles: Record<string, string> = {
    login: "text-blue-400",
    logout: "text-gray-400",
    register: "text-green-400",
    "flipkart-login": "text-yellow-400",
    "pdf-generated": "text-purple-400",
    "pdf-printed": "text-indigo-400",
    "rtd-completed": "text-emerald-400",
    error: "text-red-400",
  };
  return <span className={`font-medium ${styles[event] || "text-gray-300"}`}>{event}</span>;
}
