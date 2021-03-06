// ----------------------------------------------------------------------------
// sprites-tests.js
// Enuma Sprites PoC
//
// Copyright (c) 2018 Enuma Technologies Limited.
// https://www.enuma.io/
// ----------------------------------------------------------------------------

const {curry, assoc, dissoc, omit, pipeP} = require('ramda')
const {thread, threadP} = require('../fp.js')
const {inspect} = require('util')
const Web3Eth = require('web3-eth')
const H = require('../test-helpers.js')
const Sprites = require('../sprites.js')
const OffChainRegistry = require('../off-chain-registry.js')

async function mineDummyBlock(web3Provider, account) {
    const eth = new Web3Eth(web3Provider)
    return eth.sendTransaction({from: account, to: account})
}

async function waitForDispute(sprites) {
    const {web3Provider} = sprites
    const [DEPLOYER] = await H.waitForAccounts(web3Provider)
    for (let i = 0; i < 10; i++) {
        await mineDummyBlock(web3Provider, DEPLOYER)
    }
    return sprites
}

async function nonce({web3Provider, ownAddress}) {
    const eth = new Web3Eth(web3Provider)
    return eth.getTransactionCount(ownAddress)
}

const confirmWith = curry(async (them, cmd, us) => {
    const us1 = await threadP(us,
        Sprites.channelState,
        cmd,
        Sprites.sign,
        Sprites.save)
    const {chId, channel} = us1

    // Have the counter-party blindly acknowledge our command
    const them1 = await threadP({...them, chId, channel},
        Sprites.sign,
        Sprites.save)

    return Sprites.save({...us1, channel: them1.channel})
})

describe('Sprites', () => {
    let Alice, Bob, Eve

    beforeAll(async () => {
        const inspectSprites = function () {
            const boringFields = `
                inspect
                web3Provider
                gas
                preimageManager
                token
                privateKey
            `.split(/\s+/)
            return {ACTOR_NAME: this.ACTOR_NAME, ...omit(boringFields, this)}
        }

        const web3Provider =
            new Web3Eth.providers.HttpProvider('http://localhost:8545')
        const spritesTestDeployment = await Sprites.testDeploy({web3Provider})
        const {ALICE, BOB, EVE} = spritesTestDeployment.accounts
        const spritesTemplate = thread(
            spritesTestDeployment,
            assoc('inspect', inspectSprites),
            dissoc('accounts'))

        Alice = thread(spritesTemplate,
            assoc('ACTOR_NAME', 'Alice'),
            assoc('ownAddress', ALICE),
            assoc('offChainReg', new OffChainRegistry({ownAddress: ALICE})),
            Sprites.withWeb3Contracts,
            Sprites.withRemoteSigner)

        Bob = thread(spritesTemplate,
            assoc('ACTOR_NAME', 'Bob'),
            assoc('ownAddress', BOB),
            assoc('offChainReg', new OffChainRegistry({ownAddress: BOB})),
            Sprites.withWeb3Contracts,
            Sprites.withRemoteSigner)

        Eve = thread(spritesTemplate,
            assoc('ACTOR_NAME', 'Eve'),
            assoc('ownAddress', EVE),
            assoc('offChainReg', new OffChainRegistry({ownAddress: EVE})),
            Sprites.withWeb3Contracts,
            Sprites.withRemoteSigner)
    })

    describe('Prerequisites', function () {
        test('ALICE is funded', async () => {
            expect(await Sprites.tokenBalance(Alice))
                .toHaveProperty('tokenBalance', 1e3)
        })
    })

    test('#create', async function () {
        const {chId, channel} = await threadP(Alice,
            Sprites.create(Bob.ownAddress),
            Sprites.channelOnChain)

        expect(channel).toMatchObject({
            chId,
            deposits: [0, 0],
            credits: [0, 0],
            withdrawals: [0, 0],
            withdrawn: [0, 0],
            round: -1,
            amount: 0,
            expiry: 0,
            preimageHash: H.ZERO_BYTES32,
            recipient: H.ZERO_ADDR,
            players: [Alice.ownAddress, Bob.ownAddress]
        })
    })

    test('#deposit', async function () {
        const amt = 10
        const {tokenBalance: balanceBeforeDeposit} = await Sprites.tokenBalance(Alice)

        const Alice1 = await threadP(Alice,
            Sprites.create(Bob.ownAddress),
            Sprites.approve(amt),
            Sprites.deposit(amt),
            Sprites.channelOnChain,
            Sprites.tokenBalance)

        expect(Alice1).toHaveProperty('channel.deposits', [amt, 0])
        expect(Alice1.tokenBalance).toEqual(balanceBeforeDeposit - amt)
    })

    test('#cmd.envelop', async () => {
        const amt = 10
        const Alice1 = await threadP(Alice,
            Sprites.create(Bob.ownAddress),
            Sprites.approve(amt),
            Sprites.deposit(amt),
            Sprites.channelState)

        const ownIdx = Sprites.ownIdx(Alice1)

        const mail = await threadP(Alice1,
            Sprites.cmd.withdraw(amt),
            Sprites.sign,
            Sprites.cmd.envelop)

        expect(mail)
            .toMatchObject({
                from: Alice1.ownAddress,
                to: Bob.ownAddress,
                reg: Alice1.reg.options.address,
                chId: Alice1.chId,
                round: Alice1.channel.round + 1,
                cmd: {
                    name: 'withdraw',
                    params: [ownIdx, amt]
                }
            })
        expect(mail.sigs[0]).toHaveLength(3)
    })

    describe('#update', function () {
        test('works', async function () {
            const amt = 10

            const Alice1 = await threadP(Alice,
                Sprites.approve(amt),
                Sprites.createWithDeposit(Bob.ownAddress, amt),
                Sprites.channelState,
                Sprites.cmd.withdraw(3),
                Sprites.sign)

            const {chId} = Alice1

            const Bob1 = await threadP(
                {...Bob, chId, channel: Alice1.channel},
                Sprites.sign)

            const Alice2 = {...Alice1, channel: Bob1.channel}

            expect(await Sprites.verifyUpdate(Alice2))
                .toEqual(true)

            expect(await Sprites.update(Alice2))
                .toHaveProperty("tx.status", true)

            expect(await Sprites.channelOnChain(Alice2))
                .toHaveProperty("channel.withdrawals", [3, 0])
        })

        test('withdrawal', async function () {
            const amt = 10
            const Alice1 = await threadP(Alice,
                Sprites.create(Bob.ownAddress),
                Sprites.approve(amt),
                Sprites.deposit(amt),
                confirmWith(Bob, Sprites.cmd.withdraw(amt)))

            expect(await Sprites.verifyUpdate(Alice1))
                .toEqual(true)

            expect(await Sprites.update(Alice1))
                .toHaveProperty("tx.status", true)

            expect(await Sprites.channelOnChain(Alice1))
                .toHaveProperty("channel.withdrawals", [10, 0])
        })
    })

    describe('#withdraw', function () {
        test('total amount cooperatively', async function () {
            const amt = 10
            const {tokenBalance: balanceBeforeDeposit} = await Sprites.tokenBalance(Alice)

            const Alice1 = await threadP(Alice,
                Sprites.create(Bob.ownAddress),
                Sprites.approve(amt),
                Sprites.deposit(amt),
                confirmWith(Bob, Sprites.cmd.withdraw(amt)),
                Sprites.update,
                Sprites.withdraw,
                Sprites.channelState,
                Sprites.tokenBalance)

            expect(Alice1.channel).toHaveProperty('withdrawn', [10, 0])
            expect(Alice1.tokenBalance).toEqual(balanceBeforeDeposit)
        })

        describe('remaining amounts cooperatively after off-chain payment', function () {
            test('using primitive methods', async function () {
                const amt = 10
                const {tokenBalance: AlicesInitialBalance} = await Sprites.tokenBalance(Alice)
                const {tokenBalance: BobsInitialBalance} = await Sprites.tokenBalance(Bob)

                const Alice1 = await threadP(Alice,
                    Sprites.create(Bob.ownAddress),
                    Sprites.approve(amt),
                    Sprites.deposit(amt),
                    confirmWith(Bob, Sprites.cmd.pay(3)),
                    confirmWith(Bob, Sprites.cmd.withdraw(7)),
                    Sprites.update,
                    Sprites.withdraw,
                    Sprites.channelState,
                    Sprites.tokenBalance)
                const {chId} = Alice1

                expect(Alice1.tokenBalance).toEqual(AlicesInitialBalance - 3)
                expect(Alice1.channel).toHaveProperty('withdrawn', [7, 0])

                const Bob1 = await threadP({...Bob, chId},
                    confirmWith(Alice1, Sprites.cmd.withdraw(3)),
                    Sprites.update,
                    Sprites.withdraw,
                    Sprites.channelState,
                    Sprites.tokenBalance)

                expect(Bob1.tokenBalance).toEqual(BobsInitialBalance + 3)
                expect(Bob1.channel).toHaveProperty('withdrawn', [7, 3])
            })

            test('using combined methods', async function () {
                const amt = 10
                const startNonce = await nonce(Alice)
                const {tokenBalance: AlicesInitialBalance} = await Sprites.tokenBalance(Alice)
                const {tokenBalance: BobsInitialBalance} = await Sprites.tokenBalance(Bob)

                const Alice1 = await threadP(Alice,
                    Sprites.approve(amt),
                    Sprites.createWithDeposit(Bob.ownAddress, amt),
                    confirmWith(Bob, Sprites.cmd.pay(3)),
                    confirmWith(Bob, Sprites.cmd.withdraw(7)),
                    Sprites.updateAndWithdraw,
                    Sprites.channelState,
                    Sprites.tokenBalance)
                const {chId} = Alice1

                expect(Alice1.channel).toHaveProperty('withdrawn', [7, 0])
                expect(Alice1.tokenBalance - AlicesInitialBalance).toEqual(-3)

                expect((await nonce(Alice1)) - startNonce)
                    .toBeLessThanOrEqual(3)

                const Bob1 = await threadP({...Bob, chId},
                    confirmWith(Alice1, Sprites.cmd.withdraw(3)),
                    Sprites.updateAndWithdraw,
                    Sprites.channelState,
                    Sprites.tokenBalance)

                expect(Bob1.tokenBalance).toEqual(BobsInitialBalance + 3)
                expect(Bob1.channel).toHaveProperty('withdrawn', [7, 3])
            })
        })

        test('non-cooperatively', async function () {
            const amt = 10
            const {tokenBalance: AlicesInitialBalance} = await Sprites.tokenBalance(Alice)

            const Alice1 = await threadP(Alice,
                Sprites.approve(amt),
                Sprites.createWithDeposit(Bob.ownAddress, amt),
                confirmWith(Bob, Sprites.cmd.pay(3)))
            // Alice has her payment accepted by Bob at this stage

            const Alice2 = await threadP(Alice1,
                Sprites.cmd.withdraw(7),
                Sprites.sign,
                // and she tries to get Bob sign a withdrawal,
                // but Bob is not available
                Sprites.save)

            // so Alice triggers a dispute with her previous confirmed state
            const Alice3 = await threadP(Alice1,
                Sprites.update,
                Sprites.trigger,
                waitForDispute,
                Sprites.finalize,
                Sprites.withdraw,
                Sprites.channelState,
                Sprites.tokenBalance)

            expect(Alice3.channel).toHaveProperty('withdrawn', [7, 0])
            expect(Alice3.tokenBalance).toEqual(AlicesInitialBalance - 3)
        })

        describe('by receiver, from multiple channels', async function () {
            test('takes multiple transactions', async function () {
                jest.setTimeout(10000)
                const {tokenBalance: BobsInitialBalance} = await Sprites.tokenBalance(Bob)

                const channelWithBob = async (someone) =>
                    threadP(someone,
                        Sprites.approve(10),
                        Sprites.createWithDeposit(Bob.ownAddress, 10),
                        Sprites.channelState)

                const payToBob = async (someone) => {
                    const {chId} = someone
                    await threadP(someone,
                        confirmWith(Bob, Sprites.cmd.pay(3)),
                        confirmWith(Bob, Sprites.cmd.withdraw(7)))

                    await threadP({...Bob, chId},
                        confirmWith(someone, Sprites.cmd.withdraw(3)))

                    return Sprites.channelState(someone)
                }

                const withdrawByBob = async ({chId}) =>
                    threadP({...Bob, chId},
                        Sprites.channelState,
                        Sprites.updateAndWithdraw)

                await Promise.all([Alice, Eve]
                    .map(pipeP(channelWithBob, payToBob, withdrawByBob)))

                expect(await Sprites.tokenBalance(Bob))
                    .toHaveProperty('tokenBalance', BobsInitialBalance + 3 + 3)
            })
        })
    })
})
