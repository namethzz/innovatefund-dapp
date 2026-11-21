// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

contract InnovateFund {
    enum Status { Funding, Funded, GoalMissed, Terminated, Complete }
    enum Movement { Contribution, Payout, Refund }

    struct Campaign {
        address owner;
        string title;
        string description;
        uint256 goal;
        uint256 raised;
        uint256 paid;
        uint256 refunded;
        uint64 fundingDeadline;
        uint64 requestDeadline;
        uint64 requestWindow;
        uint64 votingWindow;
        uint32 nextMilestone;
        bool terminated;
    }

    struct MilestoneInput {
        string title;
        string description;
        uint256 allocation;
    }

    struct Milestone {
        string title;
        string description;
        uint256 allocation;
        string evidence;
        uint64 voteDeadline;
        uint256 approvedWeight;
        bool paid;
    }

    struct Entry {
        Movement kind;
        address account;
        uint256 amount;
        uint64 timestamp;
        uint32 milestone;
    }

    uint256 public campaignCount;
    mapping(uint256 => Campaign) private campaigns;
    mapping(uint256 => Milestone[]) private milestones;
    mapping(uint256 => Entry[]) private ledger;
    mapping(uint256 => mapping(address => uint256)) public contributions;
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public voted;
    mapping(uint256 => mapping(address => bool)) public refunded;
    mapping(uint256 => uint256) private refundedWeight;
    bool private sending;

    event CampaignCreated(uint256 indexed id, address indexed owner);
    event ReleaseRequested(uint256 indexed id, uint256 indexed milestone, uint64 voteDeadline);
    event VoteApproved(uint256 indexed id, uint256 indexed milestone, address indexed contributor, uint256 weight);
    event CampaignTerminated(uint256 indexed id);
    event FundsMoved(uint256 indexed id, Movement kind, address indexed account, uint256 amount, uint32 milestone);

    modifier nonReentrant() {
        require(!sending, "Reentrant call");
        sending = true;
        _;
        sending = false;
    }

    function createCampaign(
        string calldata title, string calldata description, uint64 fundingSeconds,
        uint64 requestSeconds, uint64 votingSeconds, MilestoneInput[] calldata plan
    ) external returns (uint256 id) {
        require(bytes(title).length > 0 && bytes(title).length <= 160, "Invalid title");
        require(bytes(description).length > 0 && bytes(description).length <= 1600, "Invalid description");
        require(validWindow(fundingSeconds) && validWindow(requestSeconds) && validWindow(votingSeconds), "Invalid duration");
        require(plan.length > 0 && plan.length <= 10, "Invalid milestones");
        id = ++campaignCount;
        Campaign storage campaign = campaigns[id];
        campaign.owner = msg.sender;
        campaign.title = title;
        campaign.description = description;
        campaign.fundingDeadline = uint64(block.timestamp + fundingSeconds);
        campaign.requestWindow = requestSeconds;
        campaign.votingWindow = votingSeconds;
        for (uint256 i; i < plan.length; ++i) {
            MilestoneInput calldata step = plan[i];
            require(bytes(step.title).length > 0 && bytes(step.title).length <= 240, "Invalid milestone title");
            require(bytes(step.description).length > 0 && bytes(step.description).length <= 1200, "Invalid milestone description");
            require(step.allocation > 0, "Invalid allocation");
            campaign.goal += step.allocation;
            milestones[id].push(Milestone(step.title, step.description, step.allocation, "", 0, 0, false));
        }
        // Bound the amount so proportional refund multiplication is safe.
        require(campaign.goal <= type(uint128).max, "Goal too large");
        emit CampaignCreated(id, msg.sender);
    }

    function contribute(uint256 id) external payable {
        Campaign storage campaign = getExisting(id);
        require(status(id) == Status.Funding, "Funding is closed");
        require(msg.sender != campaign.owner, "Owner cannot contribute");
        require(msg.value > 0 && msg.value <= campaign.goal - campaign.raised, "Amount exceeds funding gap");
        campaign.raised += msg.value;
        contributions[id][msg.sender] += msg.value;
        if (campaign.raised == campaign.goal) {
            campaign.requestDeadline = uint64(block.timestamp + campaign.requestWindow);
        }
        addEntry(id, Movement.Contribution, msg.sender, msg.value, 0);
    }

    function requestRelease(uint256 id, string calldata evidence) external {
        Campaign storage campaign = getExisting(id);
        require(msg.sender == campaign.owner, "Owner only");
        require(status(id) == Status.Funded && block.timestamp < campaign.requestDeadline, "Request window closed");
        Milestone storage milestone = milestones[id][campaign.nextMilestone];
        require(milestone.voteDeadline == 0, "Already requested");
        require(bytes(evidence).length > 0 && bytes(evidence).length <= 1200, "Invalid evidence");
        milestone.evidence = evidence;
        milestone.voteDeadline = uint64(block.timestamp + campaign.votingWindow);
        emit ReleaseRequested(id, campaign.nextMilestone, milestone.voteDeadline);
    }

    function approveMilestone(uint256 id) external {
        Campaign storage campaign = getExisting(id);
        require(status(id) == Status.Funded, "Campaign not funded");
        uint256 index = campaign.nextMilestone;
        Milestone storage milestone = milestones[id][index];
        require(milestone.voteDeadline > block.timestamp, "Voting is closed");
        uint256 weight = contributions[id][msg.sender];
        require(weight > 0 && !voted[id][index][msg.sender], "No vote available");
        voted[id][index][msg.sender] = true;
        milestone.approvedWeight += weight;
        emit VoteApproved(id, index, msg.sender, weight);
    }

    function releaseFunds(uint256 id) external nonReentrant {
        Campaign storage campaign = getExisting(id);
        require(status(id) == Status.Funded, "Campaign not funded");
        uint32 index = campaign.nextMilestone;
        Milestone storage milestone = milestones[id][index];
        require(milestone.approvedWeight > campaign.raised / 2, "Approval needs more than 50%");
        milestone.paid = true;
        campaign.paid += milestone.allocation;
        campaign.nextMilestone = index + 1;
        if (campaign.nextMilestone < milestones[id].length) {
            campaign.requestDeadline = uint64(block.timestamp + campaign.requestWindow);
        }
        addEntry(id, Movement.Payout, campaign.owner, milestone.allocation, index);
        pay(campaign.owner, milestone.allocation);
    }

    function closeFailedMilestone(uint256 id) external {
        Campaign storage campaign = getExisting(id);
        require(status(id) == Status.Funded, "Campaign not funded");
        Milestone storage milestone = milestones[id][campaign.nextMilestone];
        if (milestone.voteDeadline == 0) {
            require(block.timestamp >= campaign.requestDeadline, "Still accepting evidence");
        } else {
            require(block.timestamp >= milestone.voteDeadline, "Voting is ongoing");
            require(milestone.approvedWeight <= campaign.raised / 2, "Milestone was approved");
        }
        campaign.terminated = true;
        emit CampaignTerminated(id);
    }

    function refundContribution(uint256 id) external nonReentrant {
        Campaign storage campaign = getExisting(id);
        Status current = status(id);
        require(current == Status.GoalMissed || current == Status.Terminated, "Refunds unavailable");
        uint256 weight = contributions[id][msg.sender];
        require(weight > 0 && !refunded[id][msg.sender], "No refund available");
        refunded[id][msg.sender] = true;
        refundedWeight[id] += weight;
        uint256 pool = campaign.raised - campaign.paid;
        uint256 amount = refundedWeight[id] == campaign.raised ? pool - campaign.refunded : pool * weight / campaign.raised;
        campaign.refunded += amount;
        addEntry(id, Movement.Refund, msg.sender, amount, 0);
        if (amount != 0) pay(msg.sender, amount);
    }

    function status(uint256 id) public view returns (Status) {
        Campaign storage campaign = getExisting(id);
        if (campaign.terminated) return Status.Terminated;
        if (campaign.nextMilestone == milestones[id].length) return Status.Complete;
        if (campaign.raised == campaign.goal) return Status.Funded;
        return block.timestamp < campaign.fundingDeadline ? Status.Funding : Status.GoalMissed;
    }

    function campaignInfo(uint256 id) external view returns (Campaign memory) {
        return getExisting(id);
    }

    function campaignDetails(uint256 id) external view returns (Milestone[] memory) {
        getExisting(id);
        return milestones[id];
    }

    function historyCount(uint256 id) external view returns (uint256) {
        return ledger[id].length;
    }

    function historyEntry(uint256 id, uint256 index) external view returns (Entry memory) {
        return ledger[id][index];
    }

    function getExisting(uint256 id) private view returns (Campaign storage campaign) {
        campaign = campaigns[id];
        require(campaign.owner != address(0), "Unknown campaign");
    }

    function addEntry(uint256 id, Movement kind, address account, uint256 amount, uint32 index) private {
        ledger[id].push(Entry(kind, account, amount, uint64(block.timestamp), index));
        emit FundsMoved(id, kind, account, amount, index);
    }

    function pay(address account, uint256 amount) private {
        (bool success,) = payable(account).call{value: amount}("");
        require(success, "ETH payment failed");
    }

    function validWindow(uint256 duration) private pure returns (bool) {
        return duration >= 60 seconds && duration <= 365 days;
    }
}
