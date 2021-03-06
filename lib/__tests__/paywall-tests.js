// ----------------------------------------------------------------------------
// paywall-tests.js
// Enuma Sprites PoC
//
// Copyright (c) 2018 Enuma Technologies Limited.
// https://www.enuma.io/
// ----------------------------------------------------------------------------

const {
    map, assoc, assocPath, range, indexBy, prop, dissoc, pluck, inc, sum
} = require('ramda')
const {probe, thread, threadP, update, updatePath} = require('../fp.js')
const Web3Eth = require('web3-eth')
const SC = require('../sc.js')
const Sprites = require('../sprites.js')
const OffChainRegistry = require('../off-chain-registry.js')
const Paywall = require('../paywall.js')
const PaywallClient = require('../paywall-client.js')

async function balance(chId, paywall) {
    const {sprites} = await Paywall.channel(chId, paywall)
    return SC.balance(Sprites.ownIdx(sprites), sprites.channel)
}

describe('Paywall', () => {
    let PW, PWC0, spritesTemplate
    const newArticle = (id) => new Object({
        id: `aId-${id}`,
        price: 10 + id,
        title: `Article ${id}`,
        content: `Article ${id} content`
    })

    const Articles = map(newArticle, range(0, 2 + 1))
    const ArticleDB = indexBy(prop('id'), Articles)

    beforeAll(async () => {
        const web3Provider =
            new Web3Eth.providers.HttpProvider('http://localhost:8545')
        const spritesDeployment = await Sprites.testDeploy({web3Provider})
        ;({ALICE, BOB} = spritesDeployment.accounts)
        spritesTemplate = dissoc('accounts', spritesDeployment)

        PW = {
            ...Paywall.new(),
            db: ArticleDB,
            sprites: thread({
                    ...spritesTemplate,
                    ACTOR_NAME: 'Paywall Operator',
                    ownAddress: BOB,
                    offChainReg: new OffChainRegistry({ownAddress: BOB})
                },
                Sprites.withRemoteSigner,
                Sprites.withWeb3Contracts),
        }

        PWC0 = {
            ...PaywallClient.new(),
            sprites: thread({
                    ...Sprites.new(),
                    web3Provider,
                    ACTOR_NAME: 'Paywall Client',
                    ownAddress: ALICE,
                    offChainReg: new OffChainRegistry({ownAddress: ALICE})
                },
                Sprites.withRemoteSigner)
        }
    })

    describe('.config', () => {
        it('works', async () => {
            const addr = (contract) => PW.sprites[contract].options.address

            expect(Paywall.config(PW)).toMatchObject({
                publisher: PW.sprites.ownAddress,
                preimageManager: addr('preimageManager'),
                reg: addr('reg'),
                token: addr('token')
            })
        })
    })

    describe('.catalog', () => {
        let catalog

        beforeAll(async () => {
            catalog = await Paywall.catalog(PW)
        })

        it('does not contain the article contents', async () => {
            const contents = pluck('content', Articles)
            const catalogContent = JSON.stringify(catalog, null, 4)
            map(c => expect(catalogContent).not.toContain(c), contents)
        })
    })

    describe('with a connected client, buying an article', () => {
        let PWC, order, chId
        const article = Articles[0]
        const articleId = article.id

        beforeAll(async () => {
            const priceOfAllArticles = thread(Articles, pluck('price'), sum)
            PWC = await threadP(PWC0,
                PaywallClient.withPaywall(Paywall.config(PW)),
                PaywallClient.approve(priceOfAllArticles),
                PaywallClient.firstDeposit(priceOfAllArticles),
                PaywallClient.order(articleId))
            ;({order, sprites: {chId}} = PWC)
        })

        describe('.invoice', () => {
            let PWinv // PW with invoice
            let invoice // the invoice itself for convenience

            beforeAll(async () => {
                PWinv = await Paywall.invoice(order, PW)
                ;({invoice} = PWinv)
            })

            it('refers to the ordered article', () => {
                expect(invoice).toMatchObject({articleId})
            })

            it('describes the channel-state transition operation', () => {
                expect(invoice).toMatchObject({
                    cmd: {
                        name: 'credit',
                        params: [Sprites.ownIdx(PWinv.sprites), article.price]
                    }
                })
            })

            it('identifies the new desired channel-state', () => {
                expect(invoice).toMatchObject({
                    chId,
                    round: PWC.sprites.channel.round + 1
                })
            })

            it('signs the target channel-state', () => {
                const {channel} = PWinv.sprites
                expect(channel.sigs[0]).not.toBeDefined()
                expect(channel.sigs[1]).toBeDefined()
                expect(SC.checkAvailSigs(channel)).toBe(true)
                // If the invoice signatures match the channel state sigs,
                // we can make assertions about the channel state, which
                // state should be reconstructible by the paywall client.
                expect(invoice.sigs).toEqual(channel.sigs)
            })

            it('transfers the aritcle price to the paywall', () => {
                expect(PWinv.sprites.channel.credits)
                    .toEqual([-article.price, article.price])
            })
        })

        describe('.processPayment', () => {
            let invoice, balanceBeforePayment

            beforeAll(async () => {
                balanceBeforePayment = await balance(chId, PW)
                ;({invoice} = await Paywall.invoice(order, PW))
            })

            describe('without a signature', () => {
                let payment

                beforeAll(async () => {
                    ;({payment} = await threadP(PWC,
                        PaywallClient.pay(invoice),
                        assocPath(['payment', 'sigs', 0], null)))
                })

                it('is rejected', async () => {
                    await expect(Paywall.processPayment(payment, PW))
                        .rejects.toThrowError(/missing/i)
                })

                it('retains the channel balance', async () => {
                    await expect(balance(chId, PW))
                        .resolves.toEqual(balanceBeforePayment)
                })
            })

            describe('with invalid signature', () => {
                let payment

                beforeAll(async () => {
                    ;({payment} = await threadP(PWC,
                        PaywallClient.pay(invoice),
                        updatePath(['payment', 'sigs'],
                            ([pwc, pw]) => [pw, pw])))
                })

                it('is rejected', async () => {
                    await expect(Paywall.processPayment(payment, PW))
                        .rejects.toThrowError(/invalid/i)
                })

                it('retains the channel balance', async () => {
                    await expect(balance(chId, PW))
                        .resolves.toEqual(balanceBeforePayment)
                })
            })

            // FIXME This test should come after the failing ones
            // to make sure it doesn't modify the channel balance.
            // Ideally the tests should be more independent, but
            // that would require more articles and invoices...
            describe('with correct buyer signature', () => {
                let startRound, receipt, payment

                beforeAll(async () => {
                    const pw0 = await Paywall.channel(chId, PW)
                    startRound = pw0.sprites.channel.round
                    ;({payment} = await PaywallClient.pay(invoice, PWC))
                    ;({paymentReceipt: receipt} = await Paywall.processPayment(payment, PW))
                    await PaywallClient.processReceipt(receipt, PWC)
                })

                it('attaches the payment as reference', async () => {
                    expect(receipt).toHaveProperty('payment', payment)
                })

                it('acknowledged with a receipt', async () => {
                    // The receipt:
                    //    references the article
                    //    references the buyer/payment, so it can be rejected if necessary
                    //    doesn't require looking up old channel state (for simplicity)
                    //    can only be calculated by the paywall
                    //    it's a plus if its authenticity can be verified without db lookup
                    expect(receipt).toMatchObject({articleId, chId})
                    expect(receipt).toHaveProperty('sig')
                })

                it('increases the channel balance', async () => {
                    await expect(balance(chId, PW))
                        .resolves.toEqual(balanceBeforePayment + article.price)
                })

                it('saves the channel state', async () => {
                    const {sprites} = await Paywall.channel(chId, PW)

                    expect(sprites.channel)
                        .toHaveProperty('round', startRound + 1)

                    expect(await sprites.offChainReg.ch(chId))
                        .toHaveProperty('round', sprites.channel.round)
                })
            })
        })

        describe('.getArticle', () => {
            // FIXME article index should be automatically incremented
            const article = Articles[1]
            let receipt

            async function buy(articleId) {
                const {order} = await PaywallClient.order(articleId, PWC)
                const {invoice} = await Paywall.invoice(order, PW)
                const {payment} = await PaywallClient.pay(invoice, PWC)
                const {paymentReceipt} = await Paywall.processPayment(payment, PW)
                return await PaywallClient.processReceipt(paymentReceipt, PWC)
            }

            beforeAll(async () => {
                ;({receipt} = await buy(article.id))
            })

            it('requires a valid signature', async () => {
                const otherReceipt = update('chId', inc, receipt)
                const otherSig = await Paywall.receiptSig(otherReceipt, PW)
                const invalidReceipt = assoc('sig', otherSig, receipt)

                await expect(Paywall.getArticle(invalidReceipt, PW))
                    .rejects.toThrowError(/Invalid signture/i)
            })

            it('returns the article', async () => {
                await expect(Paywall.getArticle(receipt, PW))
                    .resolves.toMatchObject({article})
            })

            describe('after buying another article', () => {
                beforeAll(async () => {
                    await buy(Articles[2].id)
                })

                it('still returns the article', async () => {
                    await expect(Paywall.getArticle(receipt, PW))
                        .resolves.toMatchObject({article})
                })
            })
        })

        describe('.withdraw', () => {
            it('works', async () => {

                await expect(Paywall.withdraw(chId, PW))
                    .resolves.toMatch({x: "y"})
            })
        })

        describe.skip('.channel', () => {
            it('works', async () => {
                const {sprites} = await Paywall.channel(chId, PW)
                const {channel} = sprites

                expect(SC.balance(Sprites.ownIdx(sprites), channel))
                    .toEqual(article.price)

                expect(SC.balance(Sprites.otherIdx(sprites), channel))
                    .toEqual(0)
            })
        })
    })
})
