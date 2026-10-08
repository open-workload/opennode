import { useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ClerkProvider, Show, SignIn, SignUp, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import {
  Activity, ArrowDownRight, ArrowRight, ArrowUpRight, Box, Check, ChevronRight,
  CircleHelp, Clock3, Command, Cpu, Database, ExternalLink, FileText, Gauge,
  GitBranch, Layers3, LoaderCircle, LockKeyhole, LogOut, Menu, Network,
  Plus, RefreshCw, Server, Shield, ShieldAlert, Terminal, X,
} from 'lucide-react';
import { Link, Redirect, Route, Switch, Router as WouterRouter, useLocation, useParams } from 'wouter';
import {
  getGetDashboardSummaryQueryKey, getGetRunQueryKey, getGetRunLogsQueryKey,
  getListActivityQueryKey, getListMembershipProposalsQueryKey, getListNodesQueryKey,
  getListRunsQueryKey, useCancelRun, useCastMembershipVote, useCreateMembershipProposal,
  useGetDashboardSummary, useGetRun, useGetRunLogs, useHealthCheck, useListActivity,
  useListMembershipProposals, useListNodes, useListRuns, usePreflightRun,
  useRequestNodeLeave, useSubmitRun,
} from '@workspace/api-client-react';
import type { NetworkPolicy, ProposalKind, RunInput, RunMode, RunStatus } from '@workspace/api-client-react';
import NotFound from '@/pages/not-found';

const queryClient = new QueryClient();
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const clerkPubKey = publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const stripBase = (path: string) => (basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path);
const appearance = {
  theme: shadcn, cssLayerName: 'clerk',
  options: { logoPlacement: 'inside' as const, logoLinkUrl: basePath || '/', logoImageUrl: `${window.location.origin}${basePath}/logo.svg` },
  variables: {
    colorPrimary: '#286d5b', colorForeground: '#233b43', colorMutedForeground: '#687a78',
    colorBackground: '#fbfaf5', colorInput: '#fffefa', colorInputForeground: '#233b43',
    colorDanger: '#a9463f', colorNeutral: '#d9ddd5', fontFamily: '"DM Sans", sans-serif', borderRadius: '0.7rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-[#fbfaf5] rounded-2xl w-[440px] max-w-full overflow-hidden border border-[#d9ddd5]',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-[#233b43] font-semibold', headerSubtitle: 'text-[#687a78]',
    socialButtonsBlockButtonText: 'text-[#233b43]', formFieldLabel: 'text-[#344b4e]',
    footerActionLink: 'text-[#286d5b]', footerActionText: 'text-[#687a78]',
    dividerText: 'text-[#687a78]', identityPreviewEditButton: 'text-[#286d5b]',
    formFieldSuccessText: 'text-[#286d5b]', alertText: 'text-[#a9463f]',
    logoBox: 'mb-4', logoImage: 'max-h-10', socialButtonsBlockButton: 'border-[#d9ddd5] bg-[#fffefa]',
    formButtonPrimary: 'bg-[#286d5b] hover:bg-[#205849]', formFieldInput: 'border-[#d9ddd5] bg-[#fffefa]',
    footerAction: 'border-t border-[#e5e5dc]', dividerLine: 'bg-[#d9ddd5]', alert: 'bg-[#f7e8e4]',
    otpCodeFieldInput: 'border-[#d9ddd5]', formFieldRow: 'text-[#344b4e]', main: 'text-[#233b43]',
  },
};

const paths = [
  { href: '/user-portal', label: 'Overview', icon: Gauge },
  { href: '/nodes', label: 'Peer network', icon: Network },
  { href: '/membership', label: 'Membership', icon: GitBranch },
  { href: '/runs', label: 'Run history', icon: Layers3 },
];
const date = (value?: string | null) => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not reported';
const titleCase = (value?: string | null) => (value || 'unknown').replaceAll('_', ' ');
const statusClass = (value?: string | null) => {
  const safe = (value || 'unknown').replaceAll('_', '-');
  return `status status-${safe}`;
};

function Brand({ inverse = false }: { inverse?: boolean }) {
  return <Link href="/" className={`brand ${inverse ? 'brand-inverse' : ''}`} data-testid="link-brand">
    <span className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></span>
    <span>open<span className="brand-light">node</span></span>
  </Link>;
}

function ProductHome() {
  const health = useHealthCheck();
  return <main className="landing">
    <header className="landing-nav"><Brand /><nav aria-label="Main navigation">
      <a href="#how-it-works" data-testid="link-how-it-works">How it works</a>
      <a href="#principles" data-testid="link-principles">Operating principles</a>
      <Link href="/sign-in" className="nav-signin" data-testid="link-sign-in">Sign in <ArrowRight size={15} /></Link>
    </nav></header>
    <section className="hero">
      <div className="hero-copy"><p className="eyebrow"><span className="pulse-dot" /> DECENTRALIZED WORKLOAD OPERATIONS</p>
        <h1>Workloads,<br /><em>without</em> a center.</h1>
        <p className="hero-lede">Admit peers with a vote. Submit a safe test from any node. See the same history across the cluster.</p>
        <div className="hero-actions"><Link href="/sign-up" className="button button-primary" data-testid="link-create-account">Open your operator console <ArrowRight size={17} /></Link><a className="text-link" href="#how-it-works">Explore the system <ArrowDownRight size={16} /></a></div>
        <div className="health-line" data-testid="status-api-health"><span className={`health-led ${health.isError ? 'offline' : health.data ? 'online' : ''}`} /> API {health.isLoading ? 'checking availability' : health.isError ? 'unavailable' : health.data?.status || 'reachable'}</div>
      </div>
      <div className="hero-graphic" aria-label="Illustration of connected workload nodes">
        <div className="graphic-top"><span>CLUSTER TOPOLOGY</span><span className="mono">EPOCH 08</span></div>
        <div className="mesh">
          <div className="mesh-line line-a" /><div className="mesh-line line-b" /><div className="mesh-line line-c" /><div className="mesh-line line-d" /><div className="mesh-line line-e" />
          <div className="mesh-node node-central"><span className="node-glyph"><Network size={20} /></span><b>opn-01</b><small>LOCAL · VALIDATOR</small></div>
          <div className="mesh-node node-left"><span className="node-glyph"><Server size={17} /></span><b>opn-02</b><small>PEER</small></div>
          <div className="mesh-node node-right"><span className="node-glyph"><Cpu size={17} /></span><b>opn-03</b><small>WORKER</small></div>
          <div className="mesh-node node-bottom"><span className="node-glyph"><Database size={17} /></span><b>opn-04</b><small>SYNCING</small></div>
          <div className="mesh-packet" />
        </div>
        <div className="graphic-foot"><span><i className="key-dot" /> 3 peers connected</span><span>consensus · healthy</span></div>
      </div>
      <div className="hero-index"><span>01</span><span>LOCAL CONTROL / SHARED HISTORY</span><span>SCROLL TO EXPLORE ↓</span></div>
    </section>
    <section className="ticker" aria-label="Product capabilities"><span>PEER ADMISSION</span><i /><span>QUORUM-AWARE</span><i /><span>SAFE PREFLIGHT</span><i /><span>SYNCHRONIZED HISTORY</span><i /><span>OPERATOR CONTROL</span></section>
    <section id="how-it-works" className="story-section">
      <div className="section-intro"><p className="eyebrow">A SMALL, CLEAR OPERATING LOOP</p><h2>Every action has<br />a visible <em>reason.</em></h2><p>No assumed workers. No hidden quorum. OpenNode shows what this cluster can do right now, before you ask it to do anything.</p></div>
      <div className="steps">
        {[
          { n: '01', title: 'Build membership', icon: Network, text: 'Propose a peer, inspect threshold progress, then record votes with the epoch they belong to.' },
          { n: '02', title: 'Check before dispatch', icon: Shield, text: 'Preflight reports execution mode and cluster readiness before a workload can be submitted.' },
          { n: '03', title: 'Follow the record', icon: Terminal, text: 'Trace each run, attempt, and ordered log entry. Cancellation is a request, not a promise.' },
        ].map(({ n, title, icon: Icon, text }) => <article className="step" key={n}><div className="step-head"><span>{n}</span><Icon size={20} /></div><h3>{title}</h3><p>{text}</p><div className="step-rule" /></article>)}
      </div>
    </section>
    <section id="principles" className="principles">
      <div className="principles-visual"><div className="orbit orbit-outer" /><div className="orbit orbit-inner" /><div className="orbit-core"><Command size={31} /><span>OPEN<br />NODE</span></div><div className="orbit-label label-one">LOCAL FIRST</div><div className="orbit-label label-two">NO ASSUMPTIONS</div><div className="orbit-label label-three">AUDITABLE</div></div>
      <div className="principles-copy"><p className="eyebrow">BUILT FOR THE MOMENT BEFORE SUBMIT</p><h2>Calm is a<br /><em>control surface.</em></h2><p>Operational pressure is exactly when interfaces should stop guessing. OpenNode treats local-only operation, missing quorum, and unavailable execution as first-class states—not footnotes.</p><div className="principle-list"><div><LockKeyhole size={17} /><span><b>Explicit permissions</b><small>Membership changes are proposals, never silent joins.</small></span></div><div><ShieldAlert size={17} /><span><b>Honest readiness</b><small>A green check means the API said it passed.</small></span></div><div><Activity size={17} /><span><b>Shared evidence</b><small>History and logs are read from the cluster API.</small></span></div></div></div>
    </section>
    <section className="cta-strip"><div><p className="eyebrow">YOUR CLUSTER, YOUR CALL</p><h2>Make the next action a deliberate one.</h2></div><Link className="button button-dark" href="/sign-up" data-testid="link-sign-up-bottom">Create an operator account <ArrowRight size={17} /></Link></section>
    <footer className="landing-footer"><Brand /><span>Cluster operations, plainly stated.</span><span className="mono">OPENNODE / 0.1</span></footer>
  </main>;
}

function AppShell({ children, current }: { children: React.ReactNode; current: string }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { signOut } = useClerk();
  const { user } = useUser();
  const active = current || location;
  return <div className="app-shell">
    <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}><div className="sidebar-brand"><Brand inverse /><button className="icon-button close-mobile" onClick={() => setMobileOpen(false)} aria-label="Close navigation" data-testid="button-close-menu"><X size={18} /></button></div>
      <div className="workspace-label">OPERATOR WORKSPACE</div><div className="cluster-mini"><span className="cluster-glyph"><Network size={17} /></span><span><b>Current cluster</b><small>Local context</small></span><ChevronRight size={14} /></div>
      <div className="side-label">OPERATE</div><nav className="side-nav" aria-label="Operator navigation">{paths.map(({ href, label, icon: Icon }) => <Link key={href} href={href} className={`side-link ${active === href || (href === '/runs' && active.startsWith('/runs/')) ? 'active' : ''}`} data-testid={`nav-${href.slice(1)}`}><Icon size={17} /><span>{label}</span>{href === '/membership' ? <span className="nav-count">•</span> : null}</Link>)}</nav>
      <div className="sidebar-spacer" /><div className="side-health"><span className="health-led online" /><span>API-connected view</span><CircleHelp size={15} /></div>
      <div className="account-box"><div className="avatar">{(user?.firstName || user?.primaryEmailAddress?.emailAddress || 'OP').slice(0, 2).toUpperCase()}</div><div className="account-copy"><b>{user?.fullName || 'Operator'}</b><small>{user?.primaryEmailAddress?.emailAddress || 'Signed in'}</small></div><button className="icon-button" aria-label="Sign out" title="Sign out" onClick={() => signOut({ redirectUrl: basePath || '/' })} data-testid="button-sign-out"><LogOut size={16} /></button></div>
    </aside>
    {mobileOpen && <button className="scrim" onClick={() => setMobileOpen(false)} aria-label="Close menu" />}
    <div className="work-area"><header className="topbar"><button className="icon-button open-mobile" onClick={() => setMobileOpen(true)} aria-label="Open navigation" data-testid="button-open-menu"><Menu size={19} /></button><div className="breadcrumbs"><span>OpenNode</span><ChevronRight size={14} /><b>{paths.find((p) => p.href === active)?.label || (active === '/runs/new' ? 'New run' : active.startsWith('/runs/') ? 'Run details' : 'Operator')}</b></div><div className="topbar-right"><span className="topbar-context"><span className="health-led online" /> LIVE DATA</span><div className="topbar-rule" /><span className="mono">NODE CONSOLE</span></div></header><main className="page-content">{children}</main></div>
  </div>;
}

function PageFrame({ title, kicker, subtitle, action, children }: { title: string; kicker: string; subtitle: string; action?: React.ReactNode; children: React.ReactNode }) {
  return <div className="page-frame"><div className="page-heading"><div><p className="eyebrow">{kicker}</p><h1>{title}</h1><p className="page-subtitle">{subtitle}</p></div>{action && <div className="heading-action">{action}</div>}</div>{children}</div>;
}

function QueryState({ loading, error, retry, children, empty, emptyTitle = 'Nothing here yet' }: { loading: boolean; error: boolean; retry: () => void; children: React.ReactNode; empty?: boolean; emptyTitle?: string }) {
  if (loading) return <div className="skeleton-panel" role="status" aria-label="Loading data"><div className="skeleton-line wide" /><div className="skeleton-line" /><div className="skeleton-line short" /></div>;
  if (error) return <div className="state-panel state-error" role="alert"><div className="state-icon"><RefreshCw size={18} /></div><b>Could not load this view</b><p>The cluster API did not return a usable response. No local values are being substituted.</p><button className="button button-outline" onClick={retry} data-testid="button-retry">Retry request <RefreshCw size={15} /></button></div>;
  if (empty) return <div className="state-panel"><div className="state-icon"><Layers3 size={19} /></div><b>{emptyTitle}</b><p>New information will appear here when the cluster reports it.</p></div>;
  return <>{children}</>;
}

function Notice({ children, kind = 'info' }: { children: React.ReactNode; kind?: string }) {
  return <div className={`notice notice-${kind}`} role="status"><span className="notice-symbol">{kind === 'warning' ? <ShieldAlert size={17} /> : <Activity size={17} />}</span><span>{children}</span></div>;
}

function Portal() {
  const q = useGetDashboardSummary();
  const summary = q.data;
  const cluster = summary?.cluster;
  return <AppShell current="/user-portal"><PageFrame title="Operator overview" kicker="CLUSTER STATUS / CURRENT VIEW" subtitle="A live read of the cluster as reported by the API." action={<Link href="/runs/new" className="button button-primary" data-testid="link-new-run"><Plus size={17} /> New test run</Link>}>
    <QueryState loading={q.isLoading} error={q.isError} retry={() => q.refetch()} empty={!summary} emptyTitle="No cluster summary available">
      {cluster && <><div className="state-band">
        <div className="state-band-main"><span className={`large-status ${cluster.consensusStatus === 'healthy' ? 'tone-good' : 'tone-warn'}`}><span className="health-led" />{titleCase(cluster.consensusStatus)}</span><div><b>{cluster.syncStatus === 'local_only' ? 'Operating locally' : titleCase(cluster.syncStatus)}</b><p>{cluster.syncStatus === 'local_only' ? 'This node has no confirmed synchronized peer view.' : `Membership epoch ${cluster.membershipEpoch} · cluster ${cluster.clusterId}`}</p></div></div>
        <div className="state-band-side"><span>SYNC STATE</span><b className={cluster.syncStatus === 'synced' ? 'text-good' : 'text-warn'}>{titleCase(cluster.syncStatus)}</b><small>{cluster.connectedCount} / {cluster.memberCount} peers connected</small></div>
      </div>
      {cluster.consensusStatus === 'no_quorum' && <Notice kind="warning">No quorum is currently reported. Membership votes or workload execution may be unavailable; check preflight before submitting.</Notice>}
      {cluster.syncStatus === 'local_only' && <Notice kind="warning">Local-only view: synchronized cluster history is not confirmed. Data below reflects only what this API instance returned.</Notice>}
      <div className="metrics-grid"><Metric label="Known peers" value={cluster.memberCount} note={`${cluster.connectedCount} connected`} icon={Network} /><Metric label="In progress" value={summary.runCounts.running + summary.runCounts.queued} note={`${summary.runCounts.running} running · ${summary.runCounts.queued} queued`} icon={Activity} /><Metric label="Completed" value={summary.runCounts.succeeded} note={`${summary.runCounts.failed} failed`} icon={Check} /><Metric label="Pending proposals" value={cluster.pendingProposalCount} note={`Epoch ${cluster.membershipEpoch}`} icon={GitBranch} /></div>
      <div className="dashboard-columns"><section className="panel"><PanelHead title="Recent runs" meta="LATEST REPORTED" href="/runs" linkText="View history" /><div className="compact-list">{summary.recentRuns?.length ? summary.recentRuns.map((run) => <Link href={`/runs/${run.id}`} className="compact-row" key={run.id} data-testid={`row-recent-run-${run.id}`}><span className="run-mark"><Terminal size={16} /></span><span className="row-main"><b>{run.name}</b><small>{run.mode} · {run.executionMode.replaceAll('_', ' ')}</small></span><span className={statusClass(run.status)}>{titleCase(run.status)}</span><ChevronRight size={15} /></Link>) : <div className="inline-empty">No runs have been reported yet.</div>}</div></section>
        <ActivityPanel /></div>
      </>}
    </QueryState>
  </PageFrame></AppShell>;
}

function Metric({ label, value, note, icon: Icon }: { label: string; value: React.ReactNode; note: string; icon: React.ElementType }) {
  return <div className="metric"><div className="metric-top"><span>{label}</span><Icon size={17} /></div><b>{value}</b><small>{note}</small></div>;
}
function PanelHead({ title, meta, href, linkText }: { title: string; meta?: string; href?: string; linkText?: string }) {
  return <div className="panel-head"><div><h2>{title}</h2>{meta && <small>{meta}</small>}</div>{href && <Link href={href} className="panel-link" data-testid={`link-${href.slice(1)}`}>{linkText} <ArrowUpRight size={14} /></Link>}</div>;
}
function ActivityPanel() {
  const q = useListActivity({ limit: 8 });
  return <section className="panel"><PanelHead title="Cluster activity" meta="RECENT EVENTS" /><QueryState loading={q.isLoading} error={q.isError} retry={() => q.refetch()} empty={!q.data?.length} emptyTitle="No activity reported"><div className="activity-list">{q.data?.map((item) => <div className="activity-row" key={item.id} data-testid={`activity-event-${item.id}`}><span className="activity-pin" /><span><b>{item.message}</b><small>{titleCase(item.kind)} · {date(item.createdAt)}</small></span></div>)}</div></QueryState></section>;
}

function NodesPage() {
  const nodesQ = useListNodes();
  const summaryQ = useGetDashboardSummary();
  const cluster = summaryQ.data?.cluster;
  return <AppShell current="/nodes"><PageFrame title="Peer network" kicker="MEMBERS / CONNECTIVITY" subtitle="Known nodes and their reported sync and execution state." action={<Link href="/membership" className="button button-outline" data-testid="link-manage-membership"><GitBranch size={16} /> Membership</Link>}>
    {cluster && <div className="context-strip"><span><span className="tiny-label">SYNC</span><b>{titleCase(cluster.syncStatus)}</b></span><span><span className="tiny-label">CONSENSUS</span><b>{titleCase(cluster.consensusStatus)}</b></span><span><span className="tiny-label">EPOCH</span><b>{cluster.membershipEpoch}</b></span><span><span className="tiny-label">CLUSTER ID</span><b className="mono">{cluster.clusterId}</b></span></div>}
    {cluster?.syncStatus === 'local_only' && <Notice kind="warning">Local-only state is reported. Peer membership and synchronized consensus should not be inferred from this view.</Notice>}
    {cluster?.consensusStatus === 'no_quorum' && <Notice kind="warning">No quorum reported. Membership proposals may not reach threshold until a quorum is available.</Notice>}
    <section className="panel table-panel"><PanelHead title="Known peers" meta={nodesQ.data ? `${nodesQ.data.length} REPORTED` : 'NODE REGISTRY'} /><QueryState loading={nodesQ.isLoading} error={nodesQ.isError} retry={() => nodesQ.refetch()} empty={!nodesQ.data?.length} emptyTitle="No peers returned by the API">
      <div className="table-wrap"><table><thead><tr><th>Peer</th><th>Role / protocol</th><th>Connectivity</th><th>Can execute</th><th>Last seen</th></tr></thead><tbody>{nodesQ.data?.map((node) => <tr key={node.id} data-testid={`row-node-${node.id}`}><td><div className="node-cell"><span className={`node-avatar ${node.isLocal ? 'node-avatar-local' : ''}`}><Server size={16} /></span><span><b>{node.name}{node.isLocal && <i className="local-tag">LOCAL</i>}</b><small className="mono">{node.id}</small></span></div></td><td><b className="role-text">{titleCase(node.role)}</b><small className="table-sub">Protocol {node.protocolVersion} · epoch {node.membershipEpoch}</small></td><td><span className={statusClass(node.status)}><span className="status-dot" />{titleCase(node.status)}</span>{node.address && <small className="table-sub mono">{node.address}</small>}</td><td>{node.canExecute ? <span className="capability-yes"><Check size={14} /> Enabled</span> : <span className="capability-no">Not available</span>}</td><td className="table-sub">{date(node.lastSeenAt)}</td></tr>)}</tbody></table></div>
    </QueryState></section>
    <div className="footnote"><LockKeyhole size={15} /> Execution capability is shown only when reported by the node API. It does not guarantee a worker is currently available.</div>
  </PageFrame></AppShell>;
}

function MembershipPage() {
  const queryClient = useQueryClient();
  const proposals = useListMembershipProposals();
  const nodes = useListNodes();
  const summary = useGetDashboardSummary();
  const create = useCreateMembershipProposal();
  const vote = useCastMembershipVote();
  const leave = useRequestNodeLeave();
  const [kind, setKind] = useState<ProposalKind>('admission');
  const [nodeId, setNodeId] = useState('');
  const [reason, setReason] = useState('');
  const [feedback, setFeedback] = useState('');
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListMembershipProposalsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListNodesQueryKey() });
  };
  const submitProposal = (event: React.FormEvent) => {
    event.preventDefault(); setFeedback('');
    create.mutate({ data: { kind, targetNodeId: nodeId.trim(), reason: reason.trim() } }, { onSuccess: () => { setNodeId(''); setReason(''); setFeedback('Proposal recorded by the API.'); invalidate(); }, onError: (e) => setFeedback(e instanceof Error ? e.message : 'Proposal could not be submitted.') });
  };
  const castVote = (id: string, choice: 'yes' | 'no') => vote.mutate({ proposalId: id, data: { choice } }, { onSuccess: () => { setFeedback(`Vote recorded: ${choice}.`); invalidate(); }, onError: (e) => setFeedback(e instanceof Error ? e.message : 'Vote could not be recorded.') });
  const requestLeave = () => {
    if (window.confirm('Request voluntary leave for this local node? This creates a cluster membership action.')) leave.mutate({ data: { reason: 'Voluntary operator request' } }, { onSuccess: (result) => { setFeedback(`Leave request: ${titleCase(result.status)}. Active runs to drain: ${result.activeRunsToDrain}.`); invalidate(); }, onError: (e) => setFeedback(e instanceof Error ? e.message : 'Leave request failed.') });
  };
  return <AppShell current="/membership"><PageFrame title="Membership" kicker="ADMISSION / GOVERNANCE" subtitle="Proposals move through an explicit vote threshold. The API is the authority on status." action={<button className="button button-outline button-danger" onClick={requestLeave} disabled={leave.isPending || summary.data?.cluster.localNodeId == null} data-testid="button-request-leave">{leave.isPending ? <LoaderCircle className="spin" size={16} /> : <ArrowDownRight size={16} />} Request local node leave</button>}>
    {summary.data?.cluster && <div className="context-strip"><span><span className="tiny-label">MEMBERSHIP EPOCH</span><b>{summary.data.cluster.membershipEpoch}</b></span><span><span className="tiny-label">MEMBERS</span><b>{summary.data.cluster.memberCount}</b></span><span><span className="tiny-label">CONNECTED</span><b>{summary.data.cluster.connectedCount}</b></span><span><span className="tiny-label">CONSENSUS</span><b>{titleCase(summary.data.cluster.consensusStatus)}</b></span></div>}
    {summary.data?.cluster.consensusStatus === 'no_quorum' && <Notice kind="warning">No quorum reported. Threshold progress is informational; the API may not commit a proposal until quorum returns.</Notice>}
    {feedback && <div className="form-feedback" role="status" data-testid="status-membership-feedback">{feedback}</div>}
    <div className="membership-layout"><section className="panel proposal-form"><PanelHead title="Propose a change" meta="OPERATOR ACTION" /><form onSubmit={submitProposal}>
      <label>Proposal type<select value={kind} onChange={(e) => setKind(e.target.value as ProposalKind)} data-testid="input-proposal-kind"><option value="admission">Admit a peer</option><option value="eviction">Evict a peer</option></select></label>
      <label>Target node ID<input required minLength={1} value={nodeId} onChange={(e) => setNodeId(e.target.value)} placeholder="node identifier" data-testid="input-target-node" /></label>
      {nodes.data?.length ? <div className="field-hint">Known nodes: {nodes.data.map((n) => n.name).join(', ')}</div> : null}
      <label>Reason<textarea required minLength={3} maxLength={1000} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Describe the operational reason" data-testid="input-proposal-reason" /></label>
      <button className="button button-primary full-button" disabled={create.isPending || !nodeId.trim() || reason.trim().length < 3} data-testid="button-create-proposal">{create.isPending ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />} Submit proposal</button>
    </form></section>
      <section className="proposal-list"><div className="section-top"><div><p className="eyebrow">VOTE THRESHOLDS</p><h2>Open and recent proposals</h2></div><span className="mono">CURRENT EPOCH</span></div><QueryState loading={proposals.isLoading} error={proposals.isError} retry={() => proposals.refetch()} empty={!proposals.data?.length} emptyTitle="No membership proposals">
        <div className="proposal-stack">{proposals.data?.map((p) => {
          const progress = p.requiredYesVotes > 0 ? Math.min(100, (p.yesVotes / p.requiredYesVotes) * 100) : 0;
          const canVote = p.status === 'pending' && !p.currentNodeVote;
          return <article className="proposal-card" key={p.id} data-testid={`card-proposal-${p.id}`}><div className="proposal-top"><span className={`proposal-kind kind-${p.kind}`}>{titleCase(p.kind)}</span><span className={statusClass(p.status)}>{titleCase(p.status)}</span></div><h3>{p.targetNodeName || p.targetNodeId}</h3><p>{p.reason}</p><div className="threshold-head"><span>YES THRESHOLD</span><b>{p.yesVotes} <i>/</i> {p.requiredYesVotes}</b></div><div className="threshold-track" role="progressbar" aria-label={`${p.yesVotes} of ${p.requiredYesVotes} yes votes`} aria-valuenow={p.yesVotes} aria-valuemin={0} aria-valuemax={p.requiredYesVotes}><span style={{ width: `${progress}%` }} /></div><div className="vote-stats"><span>{p.eligibleVoterCount} eligible voters</span><span>{p.noVotes} no</span><span>Epoch {p.membershipEpoch}</span></div><div className="proposal-foot"><span>{p.currentNodeVote ? `Your vote: ${titleCase(p.currentNodeVote)}` : `Expires ${date(p.expiresAt)}`}</span>{canVote && <div className="vote-actions"><button className="button button-vote" disabled={vote.isPending} onClick={() => castVote(p.id, 'yes')} data-testid={`button-vote-yes-${p.id}`}><Check size={14} /> Yes</button><button className="button button-vote button-vote-no" disabled={vote.isPending} onClick={() => castVote(p.id, 'no')} data-testid={`button-vote-no-${p.id}`}>No</button></div>}</div></article>;
        })}</div></QueryState>
      </section></div>
  </PageFrame></AppShell>;
}

function RunsPage() {
  const [status, setStatus] = useState<RunStatus | ''>('');
  const query = useListRuns({ limit: 50, status: status || undefined });
  const rows = query.data?.items || [];
  return <AppShell current="/runs"><PageFrame title="Run history" kicker="WORKLOADS / AUDIT TRAIL" subtitle="Runs returned by this node's API. History may be local-only when synchronization is degraded." action={<Link href="/runs/new" className="button button-primary" data-testid="link-create-run"><Plus size={17} /> Submit test run</Link>}>
    <div className="filterbar"><label htmlFor="run-status-filter">Filter status</label><select id="run-status-filter" value={status} onChange={(e) => setStatus(e.target.value as RunStatus | '')} data-testid="select-run-status"><option value="">All statuses</option>{['queued', 'starting', 'running', 'cancel_requested', 'succeeded', 'failed', 'cancelled', 'timed_out', 'infrastructure_error', 'blocked'].map((s) => <option value={s} key={s}>{titleCase(s)}</option>)}</select><span className="filter-count">{query.data ? `${rows.length} runs returned` : 'Waiting for API'}</span></div>
    {query.data?.nextCursor && <Notice>More runs are available beyond this page. Cursor-based pagination can continue from the API, but only the first response is shown here.</Notice>}
    <section className="panel table-panel"><QueryState loading={query.isLoading} error={query.isError} retry={() => query.refetch()} empty={!rows.length} emptyTitle={status ? `No ${titleCase(status)} runs` : 'No runs recorded'}>
      <div className="table-wrap"><table><thead><tr><th>Run</th><th>Mode / execution</th><th>Status</th><th>Submitted</th><th>Updated</th><th /></tr></thead><tbody>{rows.map((run) => <tr key={run.id} data-testid={`row-run-${run.id}`}><td><div className="node-cell"><span className="run-mark"><Terminal size={16} /></span><span><b>{run.name}</b><small className="mono">{run.id}</small></span></div></td><td><b className="role-text">{titleCase(run.mode)}</b><small className="table-sub">{titleCase(run.executionMode)}</small></td><td><span className={statusClass(run.status)}><span className="status-dot" />{titleCase(run.status)}</span></td><td className="table-sub">{date(run.createdAt)}</td><td className="table-sub">{date(run.updatedAt)}</td><td><Link href={`/runs/${run.id}`} className="row-open" aria-label={`Open ${run.name}`} data-testid={`link-run-${run.id}`}><ChevronRight size={17} /></Link></td></tr>)}</tbody></table></div>
    </QueryState></section>
  </PageFrame></AppShell>;
}

function NewRunPage() {
  const [, setLocation] = useLocation();
  const preflight = usePreflightRun();
  const submit = useSubmitRun();
  const [name, setName] = useState('Connectivity diagnostic');
  const [mode, setMode] = useState<RunMode>('diagnostic');
  const [image, setImage] = useState('');
  const [command, setCommand] = useState('echo opennode-preflight');
  const [cpuMilli, setCpu] = useState('500');
  const [memoryMiB, setMemory] = useState('512');
  const [diskMiB, setDisk] = useState('1024');
  const [timeoutSeconds, setTimeout] = useState('60');
  const [networkPolicy, setNetwork] = useState<NetworkPolicy>('deny_all');
  const [submitMessage, setSubmitMessage] = useState('');
  const data = useMemo<RunInput>(() => ({
    clientRequestId: globalThis.crypto?.randomUUID?.() || `opn-${Date.now()}-request`,
    name: name.trim(), mode, image: mode === 'container' ? (image.trim() || null) : null,
    command: command.split('\n').map((x) => x.trim()).filter(Boolean),
    resources: { cpuMilli: Number(cpuMilli), memoryMiB: Number(memoryMiB), diskMiB: Number(diskMiB), timeoutSeconds: Number(timeoutSeconds) },
    networkPolicy,
  }), [name, mode, image, command, cpuMilli, memoryMiB, diskMiB, timeoutSeconds, networkPolicy]);
  const report = preflight.data;
  const valid = name.trim().length > 0 && data.command.length > 0 && Object.values(data.resources).every((n) => Number.isFinite(n) && n > 0) && (mode !== 'container' || !!image.trim());
  const runPreflight = (e: React.FormEvent) => { e.preventDefault(); preflight.mutate({ data }, { onSuccess: () => setSubmitMessage(''), onError: (err) => setSubmitMessage(err instanceof Error ? err.message : 'Preflight request failed.') }); };
  const submitRun = () => {
    setSubmitMessage('');
    submit.mutate({ data }, { onSuccess: (run) => setLocation(`/runs/${run.id}`), onError: (err) => setSubmitMessage(err instanceof Error ? err.message : 'Run could not be submitted.') });
  };
  const hardBlocked = report && (report.canSubmit !== true || report.executionAvailable !== true || report.executionMode === 'unavailable' || report.checks.some((c) => c.status === 'blocked'));
  return <AppShell current="/runs"><PageFrame title="Submit a test run" kicker="RUN PREFLIGHT / SUBMISSION" subtitle="Check the current execution path first. Submission readiness and execution availability come from the API." action={<Link className="text-link" href="/runs"><ArrowRight size={15} /> Back to run history</Link>}>
    <div className="run-wizard"><form className="panel run-form" onSubmit={runPreflight}>
      <div className="form-section"><div className="form-section-title"><span>01</span><div><b>Workload definition</b><small>Identify exactly what this request asks to run.</small></div></div>
        <label>Run name<input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} data-testid="input-run-name" /></label>
        <label>Workload type<select value={mode} onChange={(e) => setMode(e.target.value as RunMode)} data-testid="select-run-mode"><option value="diagnostic">Built-in diagnostic</option><option value="container">Container workload</option></select></label>
        {mode === 'container' && <label>Container image<input required value={image} onChange={(e) => setImage(e.target.value)} placeholder="registry.example/image:tag" data-testid="input-run-image" /><span className="field-hint">An image is submitted as provided; this interface does not validate its registry access.</span></label>}
        <label>Command<textarea required rows={3} value={command} onChange={(e) => setCommand(e.target.value)} placeholder="One argument per line" data-testid="input-run-command" /><span className="field-hint">Each non-empty line is sent as a command argument.</span></label>
      </div>
      <div className="form-section"><div className="form-section-title"><span>02</span><div><b>Resource limits</b><small>API-bound limits for this requested workload.</small></div></div>
        <div className="resource-grid"><label>CPU · millicores<input type="number" min="100" max="16000" value={cpuMilli} onChange={(e) => setCpu(e.target.value)} data-testid="input-resource-cpu" /></label><label>Memory · MiB<input type="number" min="64" max="65536" value={memoryMiB} onChange={(e) => setMemory(e.target.value)} data-testid="input-resource-memory" /></label><label>Disk · MiB<input type="number" min="64" max="1048576" value={diskMiB} onChange={(e) => setDisk(e.target.value)} data-testid="input-resource-disk" /></label><label>Timeout · seconds<input type="number" min="1" max="86400" value={timeoutSeconds} onChange={(e) => setTimeout(e.target.value)} data-testid="input-resource-timeout" /></label></div>
        <label>Network policy<select value={networkPolicy} onChange={(e) => setNetwork(e.target.value as NetworkPolicy)} data-testid="select-network-policy"><option value="deny_all">Deny all outbound network</option><option value="allowlist">Allowlist (configured by cluster)</option></select></label>
      </div>
      <button className="button button-primary full-button" type="submit" disabled={!valid || preflight.isPending} data-testid="button-run-preflight">{preflight.isPending ? <LoaderCircle className="spin" size={16} /> : <Shield size={16} />} Run preflight</button>
      {preflight.isError && <div className="form-error" role="alert">Preflight request failed. The run is not ready to submit. Retry after reviewing the cluster connection.</div>}
      {submitMessage && <div className="form-error" role="alert" data-testid="status-run-submit-error">{submitMessage}</div>}
    </form>
      <aside className="preflight-column"><section className="panel preflight-panel"><PanelHead title="Readiness report" meta="API PREFLIGHT" />
        {!report && <div className="preflight-empty"><div className="preflight-empty-icon"><Shield size={21} /></div><b>Check before you submit</b><p>The report will show whether submission is allowed and which execution mode the cluster returned.</p></div>}
        {report && <div className="preflight-result" data-testid="panel-preflight-report"><div className={`preflight-verdict ${report.canSubmit && report.executionAvailable ? 'verdict-ready' : 'verdict-hold'}`}><span>{report.canSubmit && report.executionAvailable ? <Check size={20} /> : <ShieldAlert size={20} />}</span><div><b>{report.canSubmit ? 'Submission allowed' : 'Submission blocked'}</b><small>{report.executionAvailable ? `Execution: ${titleCase(report.executionMode)}` : `Execution unavailable · ${titleCase(report.executionMode)}`}</small></div></div>
          {(report.executionMode === 'unavailable' || !report.executionAvailable) && <Notice kind="warning">Execution is unavailable according to the API. Submitting is disabled, even if other checks pass.</Notice>}
          {report.executionMode === 'built_in_diagnostic' && <Notice>Built-in diagnostic mode was reported. No isolated worker is implied.</Notice>}
          <div className="check-list">{report.checks.map((check) => <div className="check-row" key={check.id} data-testid={`preflight-check-${check.id}`}><span className={`check-symbol check-${check.status}`}>{check.status === 'pass' ? <Check size={14} /> : check.status === 'warning' ? <CircleHelp size={14} /> : <X size={14} />}</span><span><b>{check.label}</b><small>{check.detail}</small></span><span className={`check-label check-label-${check.status}`}>{titleCase(check.status)}</span></div>)}</div>
          <button className="button button-dark full-button" onClick={submitRun} disabled={!valid || !!hardBlocked || submit.isPending} data-testid="button-submit-run">{submit.isPending ? <LoaderCircle className="spin" size={16} /> : <ArrowUpRight size={16} />} Submit run</button>
          {hardBlocked && <p className="submit-block-note">Resolve blocked checks or wait for an available execution path before submission.</p>}
        </div>}
      </section><div className="run-safety-note"><LockKeyhole size={16} /><span><b>Preflight is a snapshot.</b> Cluster state can change between the report and submission. The API response remains authoritative.</span></div></aside>
    </div>
  </PageFrame></AppShell>;
}

function RunDetailPage() {
  const params = useParams<{ runId: string }>();
  const id = params.runId || '';
  const queryClient = useQueryClient();
  const runQ = useGetRun(id, { query: { queryKey: getGetRunQueryKey(id), enabled: !!id, refetchInterval: (q) => ['queued', 'starting', 'running', 'cancel_requested'].includes(q.state.data?.status || '') ? 5000 : false } });
  const logParams = { runId: id, limit: 100 };
  const logsQ = useGetRunLogs(logParams, { query: { queryKey: getGetRunLogsQueryKey(logParams), enabled: !!id, refetchInterval: runQ.data && ['queued', 'starting', 'running', 'cancel_requested'].includes(runQ.data.status) ? 5000 : false } });
  const cancel = useCancelRun();
  const [cancelMsg, setCancelMsg] = useState('');
  const run = runQ.data;
  const canCancel = !!run && ['queued', 'starting', 'running'].includes(run.status);
  const doCancel = () => {
    if (!window.confirm('Request cancellation for this run? The request may not stop work immediately.')) return;
    cancel.mutate({ runId: id }, { onSuccess: (updated) => { queryClient.setQueryData(getGetRunQueryKey(id), updated); setCancelMsg('Cancellation request accepted by the API.'); }, onError: (e) => setCancelMsg(e instanceof Error ? e.message : 'Cancellation request failed.') });
  };
  return <AppShell current="/runs"><PageFrame title={run?.name || 'Run details'} kicker="RUN RECORD / ATTEMPTS" subtitle={run ? `Submitted ${date(run.createdAt)} · via node ${run.submittedViaNodeId}` : 'Loading run data from the API.'} action={<Link href="/runs" className="button button-outline" data-testid="link-back-runs"><ArrowRight size={15} /> All runs</Link>}>
    <QueryState loading={runQ.isLoading} error={runQ.isError} retry={() => runQ.refetch()} empty={!run} emptyTitle="Run record not available">{run && <>
      <div className="run-detail-hero"><div className="run-detail-state"><span className={`detail-status-indicator ${run.status === 'running' ? 'is-running' : ''}`} /><div><span className="eyebrow">CURRENT STATUS</span><h2>{titleCase(run.status)}</h2></div></div><div className="run-detail-actions">{canCancel && <button className="button button-danger" disabled={cancel.isPending} onClick={doCancel} data-testid="button-cancel-run">{cancel.isPending ? <LoaderCircle className="spin" size={16} /> : <X size={16} />} Request cancellation</button>}</div></div>
      {run.executionMode === 'unavailable' && <Notice kind="warning">The run reports unavailable execution. No worker execution is implied by this record.</Notice>}
      {run.executionMode === 'built_in_diagnostic' && <Notice>Built-in diagnostic execution mode. This run does not imply an isolated worker.</Notice>}
      {run.failureReason && <Notice kind="warning">Failure reported: {run.failureReason}</Notice>}
      {cancelMsg && <div className="form-feedback" role="status" data-testid="status-cancel-result">{cancelMsg}</div>}
      <div className="detail-metrics"><Metric label="Execution mode" value={titleCase(run.executionMode)} note={run.workerNodeId ? `Worker ${run.workerNodeId}` : 'No worker node reported'} icon={Cpu} /><Metric label="Attempts" value={run.attemptCount} note="Reported by run detail endpoint" icon={RefreshCw} /><Metric label="Network policy" value={titleCase(run.networkPolicy)} note="Requested workload policy" icon={LockKeyhole} /><Metric label="Submitted by" value={run.submittedBy} note={`Via ${run.submittedViaNodeId}`} icon={Server} /></div>
      <div className="detail-grid"><section className="panel"><PanelHead title="Run specification" meta={run.mode.toUpperCase()} /><div className="spec-list"><Spec label="Run ID" value={run.id} mono /><Spec label="Image" value={run.image || 'Not applicable'} mono /><Spec label="Image digest" value={run.imageDigest || 'Not reported'} mono /><Spec label="Command" value={run.command?.join(' ') || 'No command reported'} mono /><Spec label="Resources" value={`${run.resources.cpuMilli}m CPU · ${run.resources.memoryMiB} MiB memory · ${run.resources.diskMiB} MiB disk`} /><Spec label="Updated" value={date(run.updatedAt)} /></div></section>
        <section className="panel"><PanelHead title="Attempts & logs" meta={logsQ.data ? `${logsQ.data.items.length} ENTRIES` : 'ORDERED STREAM'} /><QueryState loading={logsQ.isLoading} error={logsQ.isError} retry={() => logsQ.refetch()} empty={!logsQ.data?.items.length} emptyTitle="No log entries returned"><div className="log-list">{logsQ.data?.items.map((entry) => <div className="log-entry" key={`${entry.attempt}-${entry.sequence}`} data-testid={`log-entry-${entry.sequence}`}><span className="log-seq">{String(entry.sequence).padStart(3, '0')}</span><span className={`log-stream stream-${entry.stream}`}>{entry.stream}</span><span className="log-attempt">ATTEMPT {entry.attempt}</span><time>{date(entry.createdAt)}</time><p>{entry.message}</p></div>)}</div></QueryState>{logsQ.data?.nextCursor && <div className="inline-empty">Additional log entries are available beyond the returned page.</div>}</section>
      </div>
    </>}</QueryState>
  </PageFrame></AppShell>;
}
function Spec({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div className="spec-row"><span>{label}</span><b className={mono ? 'mono' : ''}>{value}</b></div>; }

function AuthHome() { return <><Show when="signed-in"><Redirect to="/user-portal" /></Show><Show when="signed-out" treatPendingAsSignedOut><ProductHome /></Show></>; }
function Protected({ children }: { children: React.ReactNode }) { return <><Show when="signed-in">{children}</Show><Show when="signed-out"><Redirect to="/" /></Show></>; }
function SignInPage() { return <div className="auth-page"><div className="auth-backdrop"><div className="auth-brand"><Brand /><span>OPERATE WITH A CLEAR VIEW.</span></div><div className="auth-annotation"><span className="mono">OPENNODE / OPERATOR ACCESS</span><p>Peer-aware.<br />Quorum-explicit.<br /><em>Operator-led.</em></p></div></div><div className="auth-form-area"><Link href="/" className="auth-back-link" data-testid="link-auth-home"><ArrowRight size={15} /> Back to OpenNode</Link><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /></div></div>; }
function SignUpPage() { return <div className="auth-page"><div className="auth-backdrop"><div className="auth-brand"><Brand /><span>BUILD THE CLUSTER YOU CAN VERIFY.</span></div><div className="auth-annotation"><span className="mono">A NODE IS AN OPERATOR'S VIEW</span><p>Start with a<br />single node.<br /><em>Grow by consent.</em></p></div></div><div className="auth-form-area"><Link href="/" className="auth-back-link" data-testid="link-auth-home"><ArrowRight size={15} /> Back to OpenNode</Link><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /></div></div>; }

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const previousUser = useRef<string | null | undefined>(undefined);
  useEffect(() => addListener(({ user }) => {
    const nextUser = user?.id ?? null;
    if (previousUser.current !== undefined && previousUser.current !== nextUser) queryClient.clear();
    previousUser.current = nextUser;
  }), [addListener]);
  return null;
}

function RoutedApp() {
  const [, setLocation] = useLocation();
  return <ClerkProvider publishableKey={clerkPubKey} proxyUrl={clerkProxyUrl} appearance={appearance} signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`}
    localization={{ signIn: { start: { title: 'Return to your console', subtitle: 'Sign in to inspect your cluster.' } }, signUp: { start: { title: 'Create operator access', subtitle: 'Begin with a clear view of your cluster.' } } }}
    routerPush={(to: string) => setLocation(stripBase(to))} routerReplace={(to: string) => setLocation(stripBase(to), { replace: true })}>
    <ClerkQueryClientCacheInvalidator />
    <Switch>
      <Route path="/" component={AuthHome} />
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignUpPage} />
      <Route path="/user-portal">{() => <Protected><Portal /></Protected>}</Route>
      <Route path="/nodes">{() => <Protected><NodesPage /></Protected>}</Route>
      <Route path="/membership">{() => <Protected><MembershipPage /></Protected>}</Route>
      <Route path="/runs">{() => <Protected><RunsPage /></Protected>}</Route>
      <Route path="/runs/new">{() => <Protected><NewRunPage /></Protected>}</Route>
      <Route path="/runs/:runId">{() => <Protected><RunDetailPage /></Protected>}</Route>
      <Route component={NotFound} />
    </Switch>
  </ClerkProvider>;
}

function App() {
  if (!clerkPubKey) throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
  return <QueryClientProvider client={queryClient}><WouterRouter base={basePath}><RoutedApp /></WouterRouter></QueryClientProvider>;
}

export default App;
