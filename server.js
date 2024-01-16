/**
 * server.js
 *
 * function：LINE WEBHOOK サーバ
 **/

'use strict'; // strict mode

// モジュール
const express = require('express'); // express
const helmet = require('helmet'); // helmet
const https = require('https'); // https
const SQL = require('./class/sql.js'); // sql
require('dotenv').config(); // env設定

// 定数
const PORT = process.env.PORT || 3001; // ポート番号
const TOKEN = process.env.LINE_ACCESS_TOKEN; // LINEアクセストークン
const SHIPMENTFEE = 550; // 送料

// express設定
const app = express(); // express
app.use(express.json()); // json設定
app.use(
    express.urlencoded({
        extended: true, // body parser使用
    })
);
app.use(helmet()); // ヘルメット

// DB設定
const myDB = new SQL(
    process.env.HOST, // ホスト名
    process.env.MANAGEUSER, // ユーザ名
    process.env.MANAGEPASS, // ユーザパスワード
    process.env.DBNAME // DB名
);

// ユニークキー
let userkey;
// プロセス番号
let processId;
// オーダー逆流防止フラグ
let orderFlg = false;

// テスト用
app.get('/', (_, res) => {
    res.send('connected.');
});

// WEBHOOK
app.post('/webhook', async(req, _) => {
    // メッセージ
    let dataString = '';
    // 送付有無フラグ
    let sendFlg = false;
    // 二重送付有無フラグ
    let doubleSendFlg = false;
    // LINEユーザID
    const userId = req.body.events[0].source.userId;
    // 返信トークン
    const replyToken = req.body.events[0].replyToken;
    // メッセージ
    const messageStr = zen2han(req.body.events[0].message.text).toLowerCase();

    // メッセージ内容により分岐
    switch (messageStr) {
        // 登録
        case "process:regist":
            // ランダムキー
            const tmpKey = getSecureRandom(10);
            // 管理キー
            const tmpManagekey = getSecureRandom(11);
            // lineuser対象カラム
            const lineuserColumns = [
                "userid",
                "transactionkey",
                "managekey",
                "usable",
            ];
            // lineuser対象値
            const lineuserValues = [userId, tmpKey, tmpManagekey, 1];
            // ユーザ下書き作成
            const userDraft = await insertDB(
                "lineuser",
                lineuserColumns,
                lineuserValues
            );

            // エラー
            if (userDraft == "error") {
                console.log(`lineuser insertion error`);

            } else {
                console.log(
                    `initial insertion to lineuser completed for ${tmpKey}.`
                );
            }
            // メッセージ送付あり
            sendFlg = true;
            // プロセスリセット
            processId = 0;

            // オペレータ対応
            dataString = JSON.stringify({
                replyToken: replyToken, // 返信トークン
                messages: [
                    {
                        type: "text",
                        text: `登録作業を開始いたします。営業時間（平日9:00-16:00）内であれば3時間を目安にご対応します。アプリを閉じてお待ち下さい。(管理ID: ${tmpManagekey})`,
                    },
                ],
            });
            break;

        // 編集
        case "process:edit":
            // メッセージ送付あり
            sendFlg = true;
            // プロセスリセット
            processId = 0;
            // ランダムキー
            const randomKey = getSecureRandom(10);
            // DB更新（下書きを使用不可に）
            await updateDB(
                "lineuser",
                "transactionkey",
                randomKey,
                "userid",
                userId,
                null,
                null
            );

            // カード画面URL発行
            dataString = JSON.stringify({
                replyToken: replyToken, // 返信トークン
                messages: [
                    {
                        type: "text",
                        text: `下記URLをタップしてカード編集画面に移動して下さい。\nhttps://card.suijinclub.com/edit?key=${randomKey}\n有効期限：発行から24時間`,
                    },
                ],
            });
            break;

        // 「前回と同じ」押下時
        case "process:same":
            // メッセージ送付あり
            sendFlg = true;
            // プロセスID
            processId = 1;
            // 登録済LINEユーザIDを検索
            const userData = await existDB(
                "lineuser",
                "userid",
                userId,
                "usable",
                1
            );
            // 最初の要素を除去
            const arr = Object.entries(userData).shift();

            // あり
            if (arr[1] == "1") {
                // ランダムキー発行
                userkey = getSecureRandom(15);
                // お届け先前同確認
                dataString = await makeQuestionList(
                    replyToken,
                    "お届け先・ラベル",
                    "お届け先とラベルは前回と同じでよろしいですか？",
                    "はい",
                    "いいえ",
                    "process:yes",
                    "process:no"
                );

                // なし
            } else {
                // 管理キー
                const managekey = getSecureRandom(11);
                // lineuser対象カラム
                const lineuserColumns = ["userid", "managekey", "usable"];
                // lineuser対象値
                const lineuserValues = [userId, managekey, 1];
                // 注文下書き作成
                const insertDraft = await insertDB(
                    "lineuser",
                    lineuserColumns,
                    lineuserValues
                );

                // エラー
                if (insertDraft == "error") {
                    console.log(`lineuser insertion error`);

                    // 成功
                } else {
                    console.log(
                        `initial insertion to lineuser completed for ${userId}.`
                    );
                }

                // オペレータ対応
                dataString = JSON.stringify({
                    replyToken: replyToken, // 返信トークン
                    messages: [
                        {
                            type: "text",
                            text: `オペレータが手続きいたします。営業時間（平日9:00-16:00）内であれば3時間を目安にご対応します。アプリを閉じてお待ち下さい。(管理ID: ${managekey})`,
                        },
                    ],
                });
                // 対応待ち下書きカラム
                const waitColumns = [
                    "userid",
                    "managekey",
                    "status_id",
                    "waittype_id",
                ];
                // 対応待ち下書き作成
                const waitTalk = await insertDB("waittalk", waitColumns, [
                    userId,
                    managekey,
                    2,
                    1,
                ]);

                // エラー
                if (waitTalk == "error") {
                    console.log(`waittime insertion error`);

                } else {
                    console.log(
                        `inital insertion to waittime completed for ${userId}.`
                    );
                }
            }
            break;

        // ボットモード
        case "process:yes":
            // メッセージ送付あり
            sendFlg = true;

            // 戻り禁止
            if (processId > 1) {
                // 二重送付あり
                doubleSendFlg = true;
                // プロセスID
                processId = 99;
                break;
            }
            // プロセスID
            processId = 2;

            // 商品リストデータ送付
            dataString = await makeInitialList(replyToken, userId, "", false);
            break;

        // 再起動
        case "process:return":
            // メッセージ送付あり
            sendFlg = true;
            // プロセスリセット
            processId = 0;
            // DB更新（下書きを使用不可に）
            await updateDB(
                "draftorder",
                "disabled",
                1,
                "userkey",
                userkey,
                null,
                null
            );
            // 初期化商品リストデータ送付
            dataString = await makeInitialList(replyToken, userId, "", false);
            break;

        // オペレータモード
        case "process:no":
            // メッセージ送付あり
            sendFlg = true;
            // プロセスリセット
            processId = 0;
            // オペレータ対応
            dataString = JSON.stringify({
                replyToken: replyToken, // 返信トークン
                messages: [
                    {
                        type: "text",
                        text: `お手数ですがご注文の詳細を、トークにてお伝えください。`,
                    },
                ],
            });
            break;

        // 注文OK
        case "process:ok":
            // メッセージ送付あり
            sendFlg = true;

            // 戻り禁止
            if (processId > 4) {
                // 二重送付あり
                doubleSendFlg = true;
                // プロセスID
                processId = 99;
                break;
            }

            // プロセスID
            processId = 5;
            // DB更新
            await updateOrder(userkey, true);
            // 最終注文リスト作成
            const tmpText3 = await finalText(userkey, true);
            // 注文確認ダイアログ
            dataString = await makeQuestionList(
                replyToken,
                "注文確認",
                `こちらの内容でよろしいですか？\n${tmpText3}`,
                "はい",
                "いいえ",
                "process:final",
                "process:return"
            );
            break;

        // 支払い方法
        case "process:final":
            // メッセージ送付あり
            sendFlg = true;

            // 戻り禁止
            if (processId > 6) {
                // 二重送付あり
                doubleSendFlg = true;
                // プロセスID
                processId = 99;
                break;
            }

            // プロセスID
            processId = 7;
            // 金額確定
            await makeFinalPrice(userkey);
            // 注文確認ダイアログ
            dataString = await makeQuestionList(
                replyToken,
                "決済方法",
                "お支払い方法を選択してください",
                "代金引換",
                "クレジットカード",
                "process:cod",
                "process:card"
            );
            break;

        // 代金引換
        case "process:cod":
            // メッセージ送付あり
            sendFlg = true;

            // 戻り禁止
            if (processId > 7) {
                // 二重送付あり
                doubleSendFlg = true;
                // プロセスID
                processId = 99;
                break;
            }

            // プロセスID
            processId = 8;
            // トランザクションを更新
            await updateDB(
                "transaction",
                "payment_id",
                1,
                "userkey",
                userkey,
                null,
                null
            );
            // メッセージ
            dataString = JSON.stringify({
                replyToken: replyToken, // トークン
                messages: [
                    {
                        type: "text",
                        text: "ご注文ありがとうございました。",
                    },
                ],
            });
            break;

        // カード
        case "process:card":
            // メッセージ送付あり
            sendFlg = true;

            // 戻り禁止
            if (processId > 7) {
                // 二重送付あり
                doubleSendFlg = true;
                // プロセスID
                processId = 99;
                break;
            }

            // プロセスID
            processId = 8;
            // transaction対象カラム
            const transColumns = ["transactionkey"];
            // 確定注文抽出
            const transData = await selectDB(
                "transaction",
                "userkey",
                userkey,
                null,
                null,
                transColumns,
                "id",
                null,
                false
            );

            // エラー
            if (transData == "error") {
                console.log(`transaction search error`);
            }

            // トランザクションを更新
            await updateDB(
                "transaction",
                "payment_id",
                2,
                "userkey",
                userkey,
                null,
                null
            );
            // 決済画面移行
            dataString = JSON.stringify({
                replyToken: replyToken, // 返信トークン
                messages: [
                    {
                        type: "text",
                        text: `下記URLをタップして決済画面に移動して下さい。\nhttps://card.suijinclub.com/card?key=${transData[0].transactionkey}\n※発行から24時間有効`,
                    },
                ],
            });
            break;

        // デフォルト
        default:
            // メッセージ
            const tmpMessage = req.body.events[0].message.text;
            // lineuser対象カラム
            const userData2Columns = ["customerno"];
            // 顧客番号抽出
            const userData2 = await selectDB(
                "lineuser",
                "userid",
                userId,
                "usable",
                1,
                userData2Columns,
                "id",
                null,
                false
            );

            // エラー
            if (userData2 == "error") {
                console.log(`product search error 1`);
            }

            // 顧客番号
            const customerNo2 = userData2[0].customerno;

            // 「商品ID」を含む
            if (tmpMessage.includes("process:商品ID")) {
                // メッセージ送付あり
                sendFlg = true;

                // 戻り禁止
                if (processId > 3 || orderFlg) {
                    // 二重送付あり
                    doubleSendFlg = true;
                    // 戻り防止
                    orderFlg = false;
                    // プロセスID
                    processId = 99;
                    break;
                }

                // 戻り防止
                orderFlg = true;
                // プロセスID
                processId = 3;
                // メッセージ分割
                const tmpArray1 = tmpMessage.split(":");
                // カテゴリID
                const tmpCategoryId = tmpArray1[2];
                // 注文対象カラム
                const orderColumns = ["id"];
                // 対象注文下書きID抽出
                const orderData = await selectDB(
                    "draftorder",
                    "userkey",
                    userkey,
                    "tmpcategoryid",
                    tmpCategoryId,
                    orderColumns,
                    "id",
                    null,
                    true
                );

                // 商品対象カラム
                const product2Columns = ["id", "categoryid", "categoryname"];
                // カテゴリID抽出
                const product2 = await selectDB(
                    "product",
                    "categoryid",
                    tmpCategoryId,
                    "disable",
                    0,
                    product2Columns,
                    "id",
                    null,
                    false
                );

                // エラー
                if (product2 == "error") {
                    console.log(`product search error 2`);
                }

                // 重複あり
                if (orderData != "error") {
                    console.log(`duplicate exists`);
                    // 注文下書きを使用不可に
                    await updateDB(
                        "draftorder",
                        "disabled",
                        1,
                        "id",
                        orderData[orderData.length - 1].id,
                        null,
                        null
                    );
                }

                // カテゴリID
                const categoryid = product2[0].categoryid;

                // 注文下書きカラム
                const formColumns = [
                    "userid",
                    "customerno",
                    "userkey",
                    "tmpcategoryid",
                ];
                // 注文下書きデータ
                const formValues = [userId, customerNo2, userkey, categoryid];
                // 注文下書き作成
                const insertDraft = await insertDB(
                    "draftorder",
                    formColumns,
                    formValues
                );

                // エラー
                if (insertDraft == "error") {
                    console.log(`draftorder insertion error`);

                } else {
                    console.log(
                        `inital insertion to draftorder completed for ${userId}.`
                    );
                }

                // メッセージ
                dataString = JSON.stringify({
                    replyToken: replyToken, // 返信トークン
                    messages: [
                        {
                            type: "template",
                            altText: "注文数を選んでください。",
                            template: {
                                type: "buttons",
                                title: "注文数を選んでください。",
                                text: `注文商品:${product2[0].categoryname}`,
                                actions: [
                                    {
                                        type: "message",
                                        label: "6本", // 本数単価（合計）
                                        text: `process:注文数:${categoryid}:6`,
                                    },
                                    {
                                        type: "message",
                                        label: "12本", // 本数単価（合計）
                                        text: `process:注文数:${categoryid}:12`,
                                    },
                                    {
                                        type: "message",
                                        label: "24本", // 本数単価（合計）
                                        text: `process:注文数:${categoryid}:24`,
                                    },
                                    {
                                        type: "message",
                                        label: "36本", // 本数単価（合計）
                                        text: `process:注文数:${categoryid}:36`,
                                    },
                                ],
                            },
                        },
                    ],
                });

                // 「注文数」を含む
            } else if (tmpMessage.includes("process:注文数")) {
                // メッセージ送付あり
                sendFlg = true;

                // 戻り禁止
                if (processId > 3 || !orderFlg) {
                    // 二重送付あり
                    doubleSendFlg = true;
                    // 戻り防止
                    orderFlg = false;
                    // プロセスID
                    processId = 99;
                    break;
                }

                // 戻り防止
                orderFlg = false;
                // プロセスID
                processId = 3;

                // メッセージ分割
                const tmpArray2 = tmpMessage.split(":");
                // カテゴリID
                const tmpCategoryId = tmpArray2[2];
                // 注文数量
                const tmpAmount = Number(tmpArray2[3]);

                // 注文下書き更新
                await updateDB(
                    "draftorder",
                    "quantity",
                    tmpAmount,
                    "tmpcategoryid",
                    tmpCategoryId,
                    "userkey",
                    userkey
                );
                // 最終注文リスト更新
                const tmpText2 = await finalText(userkey, false);

                // メッセージリスト
                dataString = await makeInitialList(
                    replyToken,
                    userId,
                    `${tmpText2}`,
                    true
                );
            }
    }

    // 二重メッセージ送付時
    if (doubleSendFlg) {
        // 最初に戻る
        dataString = JSON.stringify({
            replyToken: replyToken, // 返信トークン
            messages: [
                {
                    type: "template",
                    altText: "もう一度最初からお願いいたします。",
                    template: {
                        type: "buttons",
                        title: "もう一度最初からお願いいたします。",
                        text: "もう一度最初からお願いいたします。",
                        actions: [
                            {
                                type: "message",
                                label: "最初に戻る",
                                text: "process:same",
                            },
                        ],
                    },
                },
            ],
        });
        // メッセージ送付
        sendMessage(dataString);
        // 最初に戻る
        const topString = gotoTop(replyToken);
        // トップに戻るメッセージ送付
        sendMessage(topString);

    } else if (sendFlg) {
        // メッセージ送付
        sendMessage(dataString);
    }
});

// 3001番待機
app.listen(PORT, () => {
   console.log(`Example app listening at http://localhost:${PORT}`);
});

// 最終注文内容作成
const finalText = async(key, flg) => {
    // テキスト連結用
    let tmpText = '';
    // 単位
    let unitStr = '';
    // 最終注文内容
    let finalStr = '';
    // 最終価格
    let lastTotalPrice = 0;
    // カウンタ
    let counter = 0;

    // 注文対象カラム
    const order1Columns = [
        'tmpcategoryid',
        'product_id',
        'quantity',
    ];
    // 注文下書きから抽出
    const draftData1 = await selectDB(
        'draftorder',
        'userkey',
        key,
        'disabled',
        0,
        order1Columns,
        'id',
        null,
        false
    );

    // エラー
    if (draftData1 == 'error') {
       console.log(`draftorder search error`);

    } else {
        // 全Promiseを待機
        await Promise.all(
            // 注文データ内ループ
            draftData1.map(async (od2) => {

                // フラグオン
                if (flg) {
                    // 商品対象カラム
                    const product6Columns = [
                        'categoryid',
                        'price',
                        'categoryname',
                    ];
                    // 商品抽出
                    const product6 = await selectDB(
                        'product',
                        'productid',
                        Number(od2.product_id),
                        'disable',
                        0,
                        product6Columns,
                        'id',
                        null,
                        false
                    );

                    // エラー
                    if (product6 == 'error') {
                        console.log(`product search error 3`);
                    }

                    // 一時カテゴリID
                    const tmpCategoryID = product6[0].categoryid;
                    // 合計金額
                    const totalprice = product6[0].price * od2.quantity;
                    // 価格加算
                    lastTotalPrice += totalprice;
                    // 数量名称
                    unitStr = makeUnitStr(tmpCategoryID);

                    // 一時改行コード
                    let tmpRet;

                    // データなし
                    if (counter == 0) {
                        tmpRet = "";

                    // データありの場合改行コード追加
                    } else {
                        tmpRet = '\n';
                    }

                    // 該当カテゴリ名あり
                    if (product6[0].categoryname) {
                        // テキスト連結
                        tmpText += `${tmpRet}${product6[0].categoryname.slice(
                            0,
                            11
                        )}x${
                            od2.quantity
                        }${unitStr}:${totalprice.toLocaleString()}円`;
                    }

                } else {
                    // 商品対象カラム
                    const product7Columns = ['categoryname', 'categoryid'];
                    // 商品抽出
                    const product7 = await selectDB(
                        'product',
                        'categoryid',
                        Number(od2.tmpcategoryid),
                        'disable',
                        0,
                        product7Columns,
                        'id',
                        null,
                        false
                    );
                    // 一時カテゴリID
                    const tmpCategoryID = product7[0].categoryid;
                    // 数量名称
                    unitStr = makeUnitStr(tmpCategoryID);
                    // 一時改行コード
                    let tmpRet;

                    // データなし
                    if (counter == 0) {
                        tmpRet = "";

                    // データありの場合改行コード追加
                    } else {
                        tmpRet = '\n';
                    }

                    // テキスト連結
                    if (product7[0].categoryname) {
                        tmpText += `${tmpRet}${product7[0].categoryname.slice(
                            0,
                            11
                        )}:${od2.quantity}${unitStr}`;
                    }
                }

                // カウンタ加算
                counter++;
            })
        );

        // 最終
        if (flg) {
            // テキスト確定
            finalStr = `${tmpText}\n送料: ${SHIPMENTFEE}円\n合計金額: ${(
                lastTotalPrice + SHIPMENTFEE
            ).toLocaleString()}円`;

        } else {
            // そのまま
            finalStr = tmpText;
        }

        // 注文内容を返す
        return finalStr;
    }
}

// 注文リスト作成
const updateOrder = userKey => {
    return new Promise(async (resolve, reject) => {
        try {
            // 注文対象カラム
            const order2Columns = ["id", "tmpcategoryid", "quantity"];
            // 下書き注文抽出
            const draftData2 = await selectDB(
                "draftorder",
                "userkey",
                userKey,
                "disabled",
                0,
                order2Columns,
                "id",
                null,
                true
            );

            // エラー
            if (draftData2 == "error") {
                console.log(`draftorder search error`);
                reject();
            }

            // 一時合計数量
            let tmpamount = 0;
            // 合計数量
            let totalamount = 0;
            // 合計金額
            draftData2.map(async (od) => {
                tmpamount += od.quantity;
            });

            // 合計数量
            if (tmpamount < 12) {
                totalamount = 6; // 6本

            } else if (tmpamount < 24) {
                totalamount = 12; // 12本

            } else if (tmpamount < 36) {
                totalamount = 24; // 24本

            } else {
                totalamount = 36; // 36本
            }

            // 全Promise待機
            const requests = await Promise.all(
                // 下書き注文内ループ
                draftData2.map(async (od1) => {
                    // カテゴリID
                    const categoryId = Number(od1.tmpcategoryid);
                    // 商品対象カラム
                    const product3Columns = ["amount"];
                    // 商品ID抽出
                    const product3 = await selectDB(
                        "product",
                        "categoryid",
                        categoryId,
                        "disable",
                        0,
                        product3Columns,
                        "id",
                        null,
                        false
                    );

                    // エラー
                    if (product3 == "error") {
                        console.log(`product search error 4`);
                    }

                    // 数量配列
                    let amountArray = [];
                    // 商品数を配列に格納
                    product3.map(async (pd) => {
                        amountArray.push(pd.amount);
                    });

                    // 最終数量初期化
                    let finalamount = 0;

                    // 数量により分岐
                    if (amountArray.length == 0) {
                        console.log("no data");

                        // 1
                    } else if (amountArray.length == 1) {
                        finalamount = amountArray[0];

                        // 2以上
                    } else if (amountArray.length > 1) {

                        // 数量のみ
                        if (amountArray.includes(totalamount)) {
                            // そのまま
                            finalamount = totalamount;

                        } else {
                            // 最低数量
                            const minNum = Math.min(...amountArray);
                            // 最大数量
                            const maxNum = Math.max(...amountArray);

                            // 最低数量が合計数量より大きい
                            if (minNum > totalamount) {
                                // 最低数量をそのまま採用
                                finalamount = minNum;

                                // 合計数量が最大数量より大きい
                            } else if (maxNum < totalamount) {
                                // 最大数量をそのまま採用
                                finalamount = maxNum;

                                // 以外はそのまま
                            } else {
                                finalamount = totalamount;
                            }
                        }
                    }

                    // ID・数量・カテゴリIDを返す
                    return {
                        id: od1.id,
                        amount: finalamount,
                        quantity: od1.quantity,
                        categoryNo: categoryId,
                    };
                })
            );

            // 全Promise待機
            await Promise.all(
                // 注文内容ループ
                requests.map(async (req) => {
                    // 商品対象カラム
                    const product5Columns = ["productid", "price"];
                    // 商品抽出
                    const product5 = await selectDB(
                        "product",
                        "amount",
                        req.amount,
                        "categoryid",
                        req.categoryNo,
                        product5Columns,
                        "id",
                        null,
                        false
                    );

                    // エラー
                    if (product5 == "error") {
                        console.log(`product search error 5`);
                    }

                    // 数量
                    const tmpQuantity = req.quantity;
                    // 合計金額
                    const totalPrice = product5[0].price * tmpQuantity;

                    // 下書き注文更新
                    await updateDB(
                        "draftorder",
                        "product_id",
                        product5[0].productid,
                        "id",
                        req.id,
                        null,
                        null
                    );
                    // 下書き注文更新
                    await updateDB(
                        "draftorder",
                        "total",
                        totalPrice,
                        "id",
                        req.id,
                        null,
                        null
                    );
                })
            );
            resolve();
            
        } catch(e) {
            // エラー
            console.log(e);
            reject(e);
        }
    });
};

// 最終金額作成
const makeFinalPrice = userKey => {
    return new Promise(async (resolve, reject) => {
        try {
            // 顧客番号
            let customerno;
            // 総額
            let totalprice = 0;
            // 総注文数
            let totalquantity = 0;
            // 商品カラム
            const priceColumns = ['id', 'userid', 'customerno', 'total', 'quantity'];
            // 注文下書きから使用可能データを抽出
            const draftData2 = await selectDB(
                'draftorder',
                'userkey',
                userKey,
                'disabled',
                0,
                priceColumns,
                'id',
                null,
                true
            );

            // エラー
            if (draftData2 == 'error') {
               console.log(`product search error 6`);
            }

            // 対象注文を足し上げる
            draftData2.map(async (od4) => {
                customerno = od4.customerno;
                totalprice += od4.total;
                totalquantity += od4.quantity;
            });
            // トランザクション対象カラム
            const formColumns = [
                'userid',
                'customerno',
                'userkey',
                'transactionkey',
                'totalprice',
                'totalquantity',
                'paid',
            ];
            // トランザクション対象値
            const formValues = [
                draftData2[0].userid,
                customerno,
                userKey,
                getSecureRandom(25),
                totalprice + SHIPMENTFEE,
                totalquantity,
                0,
            ];

            // トランザクションDB格納
            const tmpReg = await insertDB(
                'transaction',
                formColumns,
                formValues
            );

            // エラー
            if (tmpReg == 'error') {
               console.log(`transaction insertion error`);

            } else {
               console.log(
                    `initial insertion to transaction completed for ${userKey}.`
                );
            }

            // 下書き注文内ループ
            draftData2.map(async (od5) => {
                // 下書き注文更新
                await updateDB(
                    'draftorder',
                    'transaction_id',
                    tmpReg.insertId,
                    'id',
                    od5.id,
                    null,
                    null
                );
            });
            // resolved
            resolve();

        } catch(e) {
            // エラー
            console.log(e);
            reject(e);
        }
    });
};

// 質問リスト作成
const makeQuestionList = async (token, title, text, label1, label2, url1, url2) => {
    // メッセージ
    const dataString = JSON.stringify({
        replyToken: token, // 返信トークン
        messages: [
            {
                type: 'template',
                altText: title,
                template: {
                    type: 'confirm',
                    title: title,
                    text: text,
                    actions: [
                        {
                            type: 'message',
                            label: label1,
                            text: url1,
                        },
                        {
                            type: 'message',
                            label: label2,
                            text: url2,
                        },
                    ],
                },
            },
        ],
    });
    return dataString;
};

// 初期リスト作成
const makeInitialList = async (token, userID, text, flg) => {
    // タイトル
    let titleString = "";
    // 連結用
    let fixedString = "";
    // メッセージ
    let dataString = "";
    // 遷移メッセージ
    let tmpString = "";
    // 遷移先URL
    let urlString = "";
    // 新商品リスト
    let newProductArray = [];
    // 不使用フラグ
    let nouseFlg = false;
    // 商品リスト
    const productArray = await makeProductList(userID);

    // 不使用除去
    productArray.map(async (pd) => {
        // 不使用無し
        if (pd.text != "process:商品ID:0") {
            newProductArray.push(pd);

            // 不使用あり
        } else {
            nouseFlg = true;
        }
    });

    // エラー時
    if (newProductArray == "error" || newProductArray.length == 0 || nouseFlg) {
        // メッセージデータ
        dataString = JSON.stringify({
            replyToken: token, // 返信トークン
            messages: [
                {
                    type: "text",
                    text: "一升瓶又はハーフボトルのご注文はトークでご依頼下さい。",
                },
            ],
        });
    } else {
        // 注文確認
        if (flg) {
            titleString = "現在の注文内容";
            tmpString = "process:ok";
            fixedString = text;
            urlString =
                "https://ebisuan.sakura.ne.jp/ebisudo/line/ok_button.png";

            // 前回同注文
        } else {
            titleString = "前同注文";
            tmpString = "process:yes";
            fixedString = "前回の注文商品から選択してください。";
            urlString =
                "https://ebisuan.sakura.ne.jp/ebisudo/line/line_mainimage.jpg";
        }

        // メッセージデータ
        dataString = JSON.stringify({
            replyToken: token, // 返信トークン
            messages: [
                {
                    type: "template",
                    altText: "前回の注文商品から選択してください。",
                    template: {
                        type: "buttons",
                        thumbnailImageUrl: urlString,
                        imageSize: "cover",
                        title: titleString,
                        text: fixedString,
                        defaultAction: {
                            type: "message",
                            label: "View detail",
                            text: tmpString,
                        },
                        actions: newProductArray,
                    },
                },
            ],
        });
    }
    return dataString;
};

// 商品リスト作成
const makeProductList = async(userID) => {
    // ユーザ対象カラム
    const user1Columns = ['customerno'];
    // LINEUSERから顧客番号抽出
    const userData1 = await selectDB(
        'lineuser',
        'userid',
        userID,
        'usable',
        1,
        user1Columns,
        'id',
        null,
        false
    );

    // エラー
    if (userData1 == 'error') {
       console.log(`product search error 7`);
    }

    // 顧客番号
    const customerNo1 = userData1[0].customerno;
    // 履歴対象列
    const historyColumns = ['categoryid'];
    // 履歴からカテゴリIDを抽出
    const history = await selectDB(
        'ebisuorder',
        'customerno',
        customerNo1,
        null,
        null,
        historyColumns,
        'id',
        null,
        false
    );

    // エラー
    if (history == 'error') {
       console.log(`product search error 8`);
    }

    // 配列初期化
    let productArray = [];

    try {
        // 全promise待機
        await Promise.all(
            // 履歴ループ
            history.map(async (hs) => {
                return new Promise(async (resolve, _) => {
                    // カテゴリID
                    let categoryId;
                    // 商品対象列
                    const product1Columns = ['categoryid', 'categoryname'];
                    // 商品抽出
                    const product1 = await selectDB(
                        'product',
                        'categoryid',
                        hs.categoryid,
                        'disable',
                        0,
                        product1Columns,
                        'id',
                        null,
                        false
                    );

                    // エラー
                    if (product1 == 'error') {
                        // カテゴリID
                        categoryId = 0;
                        console.log(`product search error 8`);

                    } else {
                        // カテゴリID
                        categoryId = product1[0].categoryid;
                    }

                    // ソレイユ対応
                    let tmpcategoryid;

                    // ソレイユの場合
                    if (categoryId == 239 || categoryId == 999) {
                        // ソレイユ価格対象顧客を抽出
                        const soleilData = await existDB(
                            'soleil',
                            'customerno',
                            customerNo1,
                            null,
                            null
                        );
                        // 該当配列
                        const arr = Object.entries(soleilData).shift();

                        // あり
                        if (arr[1] == '1') {
                            // 本数単価ソレイユ
                            tmpcategoryid = 239;

                        } else {
                            // 固定単価ソレイユ
                            tmpcategoryid = 999;
                        }

                    } else {
                        // ソレイユ以外はそのまま
                        tmpcategoryid = categoryId;
                    }

                    // 結果が空でない
                    if (tmpcategoryid) {
                        // 結果を配列に格納
                        productArray.push({
                            type: 'message', // message
                            label: product1[0].categoryname, // カテゴリ名
                            text: `process:商品ID:${tmpcategoryid.toString()}`, // メッセージ
                        });
                    }

                    resolve();
                });
            })
        );

    } catch (e) {
        return 'error';

    } finally {

        // 商品が5つ以上
        if (productArray.length > 4) {
            // 3つに減らす
            productArray.splice(4);
        }

        // 並び替え
        productArray.sort(
            (a, b) => Number(a.text.split(':')[2]) - Number(b.text.split(':')[2])
        );

        // 結果を返す
        return productArray;
    }
}

// 数量名称を確定
const makeUnitStr = id => {
    // 一時文字列
    let unitStr = '';

    // 酒
    if (!(id == '641' || id == '1106')) {
        unitStr = '本';

    // それ以外
    } else {
        unitStr = '個';
    }

    return unitStr;
}

// 最初に戻る
const gotoTop = token => {
    return JSON.stringify({
        replyToken: token, // 返信トークン
        messages: [
            {
                type: 'text',
                text: '最初からやり直してください',
            },
        ],
    });
}

// メッセージ送付
const sendMessage = dtString => {
    // ヘッダ
    const headers = {
        'Content-Type': 'application/json', // Content-type
        Authorization: 'Bearer ' + TOKEN, // 認証トークン
    };
    // WEBHOOKオプション
    const webhookOptions = {
        hostname: 'api.line.me', // ホスト名
        path: '/v2/bot/message/reply', // 送信パス
        method: 'POST', // 認証方式
        headers: headers, // ヘッダ
        body: dtString, // data
    };

    // リクエスト
    const request = https.request(webhookOptions, (res) => {
        res.on('data', d => {
            // process.stdout.write(d);
        });
    });

    // データ送信
    request.write(dtString);
    request.end();
};

// ランダム文字列作成
const getSecureRandom = size => {
    // 一時文字列
    let result = '';
    // 生成文字リスト
    const str = 'abcdefghijklmnopqrstuvwxyz0123456789';

    // 文字を順番に格納
    for (let i = 0; i < size; i++) {
        result += str.charAt(Math.floor(Math.random() * str.length));
    }

    return result;
};

const zen2han = input => {
    return input.replace(/[！-～]/g,
        input => {
            return String.fromCharCode(input.charCodeAt(0)-0xFEE0);
        }
    );
};

// - database operation
// * exist or not
// select double from database
const existDB = (table, column1, value1, column2, value2) => {
    return new Promise(async (resolve, reject) => {
        try {

            if (column2) {
                // query
                await myDB.doInquiry(
                    'SELECT COUNT (*) FROM ?? WHERE ?? = ? AND ?? = ? LIMIT 1',
                    [table, column1, value1, column2, value2]
                );

            } else {
                // query
                await myDB.doInquiry(
                    'SELECT COUNT (*) FROM ?? WHERE ?? = ? LIMIT 1',
                    [table, column1, value1]
                );
            }

            // resolve
            resolve(myDB.getValue[0]);

        } catch (e) {
            // error
            reject(e);
        }
    });
};

// * select
// select all from table
const selectDB = (table, column1, value1, column2, value2, field, order, limit, flg) => {
    return new Promise(async (resolve, reject) => {
        try {
            // query string
            let queryString = '';
            // array
            let placeholder = [];

            // field
            if (field) {

                // if field exists
                if (column1) {
                    // query
                    queryString = "SELECT ?? FROM ?? WHERE ?? IN (?)";
                    placeholder = [field, table, column1, value1];
                    
                    // if no exist
                } else {
                    // query
                    queryString = "SELECT ?? FROM ??";
                    placeholder = [field, table];
                }
            } else {

                // if double search
                if (column1) {
                    // query
                    queryString = 'SELECT * FROM ?? WHERE ?? IN (?)';
                    placeholder = [table, column1, value1];

                // if single search
                } else {
                    // query
                    queryString = 'SELECT * FROM ??';
                    placeholder = [table];
                }
            }

            // if double query
            if (column1 && column2) {
                queryString += ' AND ?? IN (?)';
                placeholder.push(column2);
                placeholder.push(value2);
            }

            // if recent only
            if (flg) {
                
                // if double search
                if (column1) {
                    queryString += ' AND ?? > date(current_timestamp - interval 1 day)'
                
                // if single search
                } else {
                    queryString +=
                        ' WHERE ?? > date(current_timestamp - interval 1 day)';
                }
                placeholder.push('created_at');
            }

            // if order exists
            if (order) {
                queryString += ' ORDER BY ?';
                placeholder.push(order);
            }

            // if limit exists
            if (limit) {
                queryString += ' LIMIT ?';
                placeholder.push(limit);
            }

            // do query
            await myDB.doInquiry(queryString, placeholder);

            // resolve
            resolve(myDB.getValue);

        } catch (e) {
            // error
            reject(e);
        }
    });
};

// * insert
// insert into database
const insertDB = (table, columns, values) => {
    return new Promise(async (resolve, reject) => {
        try {
            // query
            await myDB.doInquiry('INSERT INTO ??(??) VALUES (?)', [table, columns, values]);
            // resolve
            resolve(myDB.getValue);

        } catch (e) {
            // error
            reject(e);
        }
    });
};

// * update
// update data
const updateDB = (
    table,
    setcol,
    setval,
    selcol1,
    selval1,
    selcol2,
    selval2
) => {
    return new Promise(async (resolve, reject) => {
        try {

            if (selcol2) {
                // query
                await myDB.doInquiry(
                    'UPDATE ?? SET ?? = ? WHERE ?? IN (?) AND ?? IN (?)',
                    [table, setcol, setval, selcol1, selval1, selcol2, selval2]
                );

            } else {
                // query
                await myDB.doInquiry(
                    'UPDATE ?? SET ?? = ? WHERE ?? IN (?)',
                    [table, setcol, setval, selcol1, selval1]
                );
            }

            // resolve
            resolve();

        } catch (e) {
            // error
            reject(e);
        }
    });
};
