"""Log message rules for logos-blockchain 0.3.x.

Each rule maps a log message (after the `target: ` prefix) to an event kind.
The first matching rule wins. Named regex groups become event fields, on top
of the `key=value` fields tracing appends to the message.

Level notes (default filter is INFO for `logos_blockchain`):
  (D) DEBUG only, (T) TRACE only - those rules only fire when the filter in
  user_config.yaml enables that level for the target.
"""

import hashlib
import re

HID = r"HeaderId\((?P<block_id>[0-9a-f]{64})\)"


class Rule:
    __slots__ = ("kind", "category", "rx", "target")

    def __init__(self, kind, category, pattern, target=None):
        self.kind = kind
        self.category = category
        self.rx = re.compile(pattern)
        self.target = target


R = Rule

RULES = [
    # ---------------------------------------------------------------- chain
    R("block_rejected", "chain", r"^Failed to process block: (?P<error>\w+)"),
    R("block_received", "chain", r"^Received proposal with ID: " + HID),  # (D)
    R("lib_advanced", "chain",  # (D) only for forky advances, (T) otherwise
      r"^LIB advanced from HeaderId\((?P<from_lib>[0-9a-f]{64})\) to HeaderId\((?P<to_lib>[0-9a-f]{64})\); "
      r"stale_blocks=(?P<stale>\d+), immutable_blocks=(?P<immutable>\d+), reorged_blocks=(?P<reorged>\d+)"),
    R("block_applied", "chain", r"^block applied; reconciling mempool"),  # (D)
    R("block_reconstruct_failed", "chain", r"^Failed to reconstruct block from proposal"),
    R("block_processing_error", "chain", r"^Error processing (reconstructed|orphan downloader) block"),
    R("future_block", "chain", r"^(Block is still from a future slot|Future block received)"),
    R("fork_pruned", "chain", r"^Pruned (?P<n>\d+) blocks from"),  # (D)
    R("forks_pruned", "chain", r"^Pruned (?P<n>\d+) old forks"),  # (D)
    R("tsi_epoch_committed", "chain", r"^Canonical TSI epoch state committed"),
    R("epoch_transition", "ledger", r"^epoch transition"),
    R("skipped_epochs", "ledger", r"^skipped epochs"),

    # ------------------------------------------------- phases / IBD / recovery
    R("phase_enter", "bootstrap", r"^entering (?P<phase>\w+)"),
    R("genesis_future", "bootstrap", r"^genesis time is in the future"),
    R("ibd_skipped", "bootstrap",
      r"^(IBD has been already skipped|Initial Block Download has been skipped|Skipping IBD as no peers)"),
    R("ibd_start", "bootstrap", r"^Starting Initial Block Download with (?P<peers>\d+) peers"),
    R("ibd_complete", "bootstrap",
      r"^(IBD complete: all configured|Initial Block Download completed successfully|IBD completed: finishing)"),
    R("ibd_failed", "bootstrap", r"^Initial Block Download failed"),
    R("ibd_tip_fetch_failed", "sync", r"^(failed to fetch tip from|no configured peer returned a tip)"),
    R("ibd_download_cancelled", "sync", r"^failed to process block; cancelling the download"),
    R("pbp_complete", "bootstrap", r"^Prolonged Bootstrap Period completed"),
    R("chain_online", "bootstrap", r"^chain switched to online"),
    R("already_online", "bootstrap", r"^chain is already not in bootstrapping state"),
    R("offline_grace", "bootstrap", r"^Offline duration measurement failed"),
    R("recovery_start", "bootstrap", r"^recovering Cryptarchia"),
    R("recovery_found", "bootstrap", r"^found (?P<n>\d+) stored blocks to replay"),
    R("recovery_done", "bootstrap", r"^(?P<n>\d+) blocks replayed\. Chain recovery finished"),
    R("recovery_loading", "bootstrap", r"^loading stored blocks for chain recovery"),
    R("recovery_progress", "bootstrap", r"^(?P<i>\d+)/(?P<total>\d+) blocks applied during initialization"),  # (D)
    R("genesis_past", "bootstrap", r"^genesis time is already in the past"),
    R("recovery_fallback", "bootstrap", r"^could not reconstruct recovered tip branch"),
    R("service_ready", "bootstrap", r"^Service '(?P<service>[^']+)' is ready"),

    # --------------------------------------------------------- node lifecycle
    R("node_start", "node", r"^Running chain (?P<chain_version>\S+) on fork (?P<fork>0x[0-9a-f]+)"),
    R("node_panic", "node", r"^A panic occurred"),
    R("node_shutdown", "node", r"^(Error while awaiting ServiceRunner's JoinHandle|Error sending Shutdown finished signal)"),
    R("service_start_timeout", "node", r"^Error while waiting for Service's task to be completed: ServiceStatuses: (?P<services>.*)"),
    R("api_error", "node", r"^response failed classification=Status code: (?P<status>\d+)"),
    R("api_busy", "node", r"^Could not (send consensus info|subscribe to new block channel)"),

    # ------------------------------------------------------------- sync / orphans
    R("tip_poll_catchup", "sync", r"^tip poll: enqueued peer tip for catch-up"),
    R("tip_poll_lagging", "sync", r"^Chain tip lagging; polling peers"),  # (D)
    R("tip_poll_watchdog", "sync", r"^Tip-poll lag watchdog enabled"),
    R("orphan_parent_missing", "sync", r"^Parent block missing"),  # (D)
    R("orphan_enqueued", "sync", r"^Orphan block enqueued for sync"),  # (D)
    R("orphan_ignored", "sync", r"^Orphan block ignored due to queue size limit"),
    R("orphan_download_start", "sync", r"^Starting new orphan block download"),  # (D)
    R("orphan_sync_done", "sync", r"^Sync for orphan block completed"),  # (D)
    R("orphan_error", "sync", r"^(Error while starting download|Error while fetching blocks|Failed to enqueue block for orphan)"),
    R("sync_request", "sync", r"^Requesting blocks from peer"),  # (D)
    R("sync_tip_request", "sync", r"^Requesting chain tip from peer"),  # (D)
    R("sync_rejected", "sync", r"^rejecting chainsync event"),  # (D) not serving peers while bootstrapping
    R("sync_event_dropped", "sync", r"^failed to send chainsync event: SendError\((?P<request>\w+)"),
    R("ibd_collecting_tips", "sync", r"^collecting unsynced tips from (?P<peers>\d+) peers"),  # (D)
    R("sync_serve", "sync", r"^(Providing blocks|Prepared block stream)"),  # (D)
    R("sync_serve_error", "sync", r"^Failed to (create a block stream|send blocks stream)"),
    R("sync_tip_timeout", "sync", r"^Timeout while receiving tip from peer"),
    R("sync_net_error", "sync", r"^(Received excessive number of additional blocks|Rejected excess pending incoming request|failed to send a (block download|tip) request|Sending response failed|Error while processing incoming request|failed to request (tip|blocks download))"),

    # --------------------------------------------------------------- leader
    R("block_proposed", "leader",
      r"^proposed block " + HID + r" with (?P<txs>\d+) transactions \((?P<removed>\d+) removed\)"),
    R("own_block_failed", "leader", r"^Failed to apply our own proposed block"),
    R("leadership_proof_failure", "leader", r"^Failed to build leadership proof"),
    R("leader_won", "leader", r"^leader for slot Slot\((?P<slot>\d+)\)"),  # (D)
    R("leader_scan", "leader",  # (T)
      r"^Leadership scan completed in (?P<duration>\S+) - slot: (?P<slot>\d+), eligible: (?P<eligible>\d+), "
      r"winning: (?P<winning>\d+)"),
    R("leader_started", "leader", r"^Chain is online\. Starting block proposals"),
    R("leader_error", "leader",
      r"^Failed to (check winning utxo|build private inputs|generate voucher|build proof|wait for proof task|fetch epoch context|select uncles|get ledger state)"),
    R("leader_blend_relay_failed", "leader", r"^(Failed to relay proposal to blend service|Refusing to publish an oversized block proposal)"),

    # ------------------------------------------------------------------ PoW
    R("pow_ticket", "pow", r"^Mined a winning ticket.*total claimable tickets (?P<claimable>\d+)"),
    R("pow_claimed", "pow", r"^Claimed (?P<n>\d+) PoW reward\(s\); (?P<ready>\d+) still ready"),
    R("pow_retired", "pow", r"^Retired (?P<n>\d+) settled PoW claim\(s\); (?P<pending>\d+) still pending"),
    R("pow_pool_spent", "pow", r"^PoW reward pool spent; (?P<ready>\d+) ticket"),
    R("pow_no_rewards", "pow", r"^No PoW rewards to claim"),
    R("pow_pruned", "pow", r"^Pruned (?P<n>\d+) expired PoW ticket"),
    R("pow_mining_started", "pow", r"^PoW mining started"),
    R("pow_mining_stopped", "pow", r"^PoW mining stopped"),
    R("pow_autoclaim_started", "pow", r"^PoW auto-claim started"),
    R("pow_autoclaim_stopped", "pow", r"^PoW auto-claim stopped"),
    R("pow_autoclaim_not_started", "pow", r"^PoW auto-claim not started"),
    R("pow_targets_reached", "pow", r"^Every PoW auto-claim target reached"),
    R("pow_error", "pow",
      r"^(Failed to claim PoW rewards|PoW auto-claim failed|Failed to pick a PoW auto-claim target|Failed to read the PoW reward pool|Failed to check settled PoW claims|Failed to read PoW auto-claim target balance)"),

    # ---------------------------------------------------------------- blend
    R("blend_mode_changed", "blend", r"^Blend mode changed"),
    R("blend_membership_ready", "blend", r"^(The )?[Cc]urrent membership is ready"),
    R("blend_conn_low", "blend",
      r"^Holding fewer connections than the protocol asks for: (?P<live>\d+) live of (?P<wanted>\d+) wanted, "
      r"(?P<dialed>\d+) of (?P<dial_wanted>\d+) opened"),
    R("blend_conn_ok", "blend",
      r"^Back to the connections the protocol asks for after (?P<rounds>\d+) round\(s\): (?P<live>\d+) live, "
      r"(?P<dialed>\d+) opened"),
    R("blend_min_network", "blend", r"^Not dialing any peers because.*?(?P<size>\d+) < (?P<min>\d+)"),
    R("blend_dial_error", "blend", r"^(Dialing error for peer|Failed to (re)?dial peer)"),
    R("blend_send_failure", "blend", r"(Failed to send message to BlendSwarm|blend_send_failure)"),
    R("blend_lagged", "blend", r"^Incoming blend message channel lagged behind: (?P<dropped>\d+)"),
    R("blend_delivery_fallback", "blend", r"did not deliver (?P<n>\d+) locally-originated payload"),
    R("blend_edge_sent", "blend", r"^Message sent successfully to peer"),
    R("blend_edge_drop", "blend",
      r"^(Giving up on message delivery|No alternative peer available|No peers available to send the message)"),
    R("blend_release", "blend",  # (D)
      r"^Sent out (?P<data>\d+) data, (?P<processed>\d+) processed and (?P<cover>\d+) cover messages"),
    R("blend_quota_exhausted", "blend", r"(Core quota exhausted|quota branch is exhausted)"),
    R("blend_activity_proof", "blend", r"^(Submitted activity proof to SDP|Requested activity proof submission)"),
    R("blend_activity_proof_failed", "blend", r"^Failed to submit activity proof"),
    R("blend_pol_check", "blend", r"^Compared private ChainLeader PoL state"),
    R("blend_dropped_proposals", "blend", r"^Dropping (?P<n>\d+) block proposal"),
    R("blend_retiring", "blend",
      r"(no longer calls for (core|broadcast) mode|does not satisfy edge node condition|Retiring)"),
    R("blend_swarm_started", "blend", r"^Blend (core|edge) swarm started"),
    R("blend_membership_rebuilt", "blend", r"^Rebuilt Blend epoch membership"),  # (D)
    R("blend_poq_failed", "blend", r"(blend_poq_verification_failed|Incoming Blend PoQ verification failed)"),
    R("blend_negotiation_failure", "blend", r"blend_peer_negotiation_failure"),
    R("blend_missed_broadcast", "blend", r"^Missed (?P<n>\d+) "),
    R("blend_epoch_state_error", "blend", r"(returned error for epoch state|Failed to query epoch state)"),

    # ------------------------------------------------------------------ SDP
    R("sdp_declaration_submitted", "sdp", r"^Submitted SDP declaration transaction"),
    R("sdp_activity_submitted", "sdp", r"^Submitted SDP activity transaction"),
    R("sdp_activity_failed", "sdp", r"^Failed to (create|submit) SDP activity transaction"),
    R("sdp_activity_committed", "sdp", r"^Canonical SDP activity committed"),
    R("sdp_behind", "sdp", r"^SDP service fell behind"),
    R("sdp_active_updated", "sdp", r"^updated declaration with active message"),
    R("sdp_genesis", "sdp", r"^Applied genesis SDP declaration"),

    # -------------------------------------------------------------- network
    R("peer_connected", "network", r"^connected to peer:"),  # (T)
    R("peer_disconnected", "network", r"^connection closed from peer"),  # (T)
    R("dial_failed", "network", r"^Failed to connect to peer"),  # (D)
    R("net_started", "network", r"^(Starting node .* with peer ID|libp2p peer_id:)"),
    R("routing_complete", "network", r"^Node has complete routing table with (?P<n>\d+) entries"),
    R("kad_mode", "network", r"^Kademlia mode changed to (?P<mode>\w+)"),
    R("kad_closest_failed", "network", r"^Failed to find closest peers"),
    R("nat_ok", "network", r"^(NAT mapping established|Successfully mapped|UPnP gateway found)"),
    R("nat_failed", "network", r"^NAT mapping failed"),
    R("gossip_oversized", "network", r"oversized (inbound )?gossipsub application data"),
    R("net_lagged", "network", r"^lagged messages: (?P<n>\d+)"),
    R("gossip_event_dropped", "network", r"^Failed to send gossipsub message event"),
    R("dial_result_dropped", "network", r"^failed to send the Ok result of dialing"),
    R("kad_address_missing", "network", r"was not present in Kademlia"),
    R("nat_gateway", "network", r"^(Initial gateway detected|Gateway address changed)"),

    # ---------------------------------------------------- wallet / mempool / time
    R("wallet_behind", "wallet", r"^Wallet fell behind"),
    R("wallet_lib", "wallet", r"^Received LIB update"),  # (D)
    R("wallet_ready", "wallet", r"^(Wallet connecting to chain|Wallet service is ready|initializing wallet with LIB)"),
    R("wallet_error", "wallet", r"^Failed to (fetch new block|backfill|fetch missing headers|apply backfill block|load block events)"),
    R("mempool_added", "mempool", r"^Added item to mempool; pending_items=(?P<pending>\d+)"),  # (D)
    R("mempool_removed", "mempool", r"^(?P<cause>[^:]+): (?P<count>\d+) items from mempool; pending_items=(?P<pending>\d+)"),  # (D)
    R("ntp_failed", "time", r"^NTP sync failed"),
    R("ntp_backwards", "time", r"^NTP resync moved backwards"),
]

_CATEGORY_PREFIXES = [
    ("chain::network::bootstrap", "bootstrap"),
    ("chain::network::sync", "sync"),
    ("chain::service::sync", "sync"),
    ("cryptarchia::sync", "sync"),
    ("chain::service::bootstrap", "bootstrap"),
    ("chain::leader", "leader"),
    ("chain", "chain"),
    ("cryptarchia", "chain"),
    ("blend", "blend"),
    ("pow", "pow"),
    ("network_service", "network"),
    ("libp2p", "network"),
    ("sdp", "sdp"),
    ("wallet", "wallet"),
    ("mempool", "mempool"),
    ("time", "time"),
    ("ledger", "ledger"),
    ("kms", "kms"),
    ("storage", "storage"),
]


def categorize_target(target):
    if not target:
        return "other"
    if target.startswith("logos_blockchain::"):
        rest = target[len("logos_blockchain::"):]
        for prefix, cat in _CATEGORY_PREFIXES:
            if rest == prefix or rest.startswith(prefix + "::"):
                return cat
        return rest.split("::")[0]
    return "ext:" + target.split("::")[0]


def rules_version(parser_version):
    """Changes whenever a rule (or the parser) changes, so stored events can be
    rebuilt from the log files still on disk."""
    h = hashlib.sha1(str(parser_version).encode())
    for r in RULES:
        h.update(("%s|%s|%s|%s\n" % (r.kind, r.category, r.rx.pattern, r.target)).encode())
    return h.hexdigest()[:16]
