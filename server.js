/**
 * index.js
 *
 * function：LINE WEBHOOK サーバ
 **/

'use strict'; // strict mode

// モジュール
const express = require('express'); // express
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
app.post('/webhook', async function (req, _) {
    // メッセージ
    let dataString = '';
    // 送付有無フラグ
    let sendFlg = false;
    
    // LINEユーザID
    const userId = req.body.events[0].source.userId;
    // 返信トークン
    const replyToken = req.body.events[0].replyToken;

    // メッセージ内容により分岐
    switch (req.body.events[0].message.text) {
        // 停止
        case "break":
            // メッセージ送付なし
            sendFlg = false;
            // プロセスリセット
            processId = 0;
            break;

        // 編集
        case "edit":
            // メッセージ送付なし
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
                userId
            );

            // オペレータ対応
            dataString = JSON.stringify({
                replyToken: replyToken, // 返信トークン
                messages: [
                    {
                        type: "text",
                        text: `下記URLをタップしてカード編集画面に移動して下さい。\nhttps://card.suijinclub.com/edit?key=${randomKey}`,
                    },
                ],
            });
            break;

        // 「前回と同じ」押下時
        case "same":
            // メッセージ送付あり
            sendFlg = true;
            // プロセスID
            processId = 1;
            // 登録済LINEユーザIDを検索
            const userData = await existDB("lineuser", "userid", userId);
            const arr = Object.entries(userData).shift();

            // あり
            if (arr[1] == "1") {
                // ランダムキー発行
                userkey = getSecureRandom(21);
                // お届け先前同確認
                dataString = await makeQuestionList(
                    replyToken,
                    "お届け先・ラベル",
                    "お届け先とラベルは前回と同じでよろしいですか？",
                    "はい",
                    "いいえ",
                    "yes",
                    "no"
                );

                // なし
            } else {
                // 管理キー
                const managekey = getSecureRandom(11);
                // lineuser対象カラム
                const lineuserColumns = ["userid", "managekey"];
                // lineuser対象値
                const lineuserValues = [userId, managekey];
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
                            text: `オペレータが対応いたします。営業時間（平日9:00-16:00）内であれば3時間を目安にご対応します。アプリを閉じてお待ち下さい。(管理ID: ${managekey})`,
                        },
                    ],
                });
            }
            break;

        // ボットモード
        case "yes":
            // メッセージ送付あり
            sendFlg = true;
            // 戻り禁止
            if (processId > 1) {
                // オペレータ対応
                dataString = JSON.stringify({
                    replyToken: replyToken, // 返信トークン
                    messages: [
                        {
                            type: "text",
                            text: "不正な操作です。",
                        },
                    ],
                });
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
        case "return":
            // メッセージ送付あり
            sendFlg = true;
            // プロセスリセット
            processId = 0;
            // DB更新（下書きを使用不可に）
            await updateDB("draftorder", "disabled", 1, "userkey", userkey);
            // 初期化商品リストデータ送付
            dataString = await makeInitialList(replyToken, userId, "", false);
            break;

        // オペレータモード
        case "no":
        case "others":
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
                        text: "オペレータが対応いたします。アプリを閉じてお待ち下さい。",
                    },
                ],
            });
            break;

        // 注文OK
        case "ok":
        case "OK":
        case "ＯＫ":
        case "ｏｋ":
            // メッセージ送付あり
            sendFlg = true;
            // 戻り禁止
            if (processId > 4) {
                // オペレータ対応
                dataString = JSON.stringify({
                    replyToken: replyToken, // 返信トークン
                    messages: [
                        {
                            type: "text",
                            text: "不正な操作です。",
                        },
                    ],
                });
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
                "final",
                "return"
            );
            break;

        // 支払い方法
        case "final":
            // メッセージ送付あり
            sendFlg = true;
            // 戻り禁止
            if (processId > 6) {
                // オペレータ対応
                dataString = JSON.stringify({
                    replyToken: replyToken, // 返信トークン
                    messages: [
                        {
                            type: "text",
                            text: "不正な操作です。",
                        },
                    ],
                });
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
                "cod",
                "card"
            );
            break;

        // 代金引換
        case "cod":
            // メッセージ送付あり
            sendFlg = true;
            // 戻り禁止
            if (processId > 7) {
                // オペレータ対応
                dataString = JSON.stringify({
                    replyToken: replyToken, // 返信トークン
                    messages: [
                        {
                            type: "text",
                            text: "不正な操作です。",
                        },
                    ],
                });
                // プロセスID
                processId = 99;
                break;
            }

            // プロセスID
            processId = 8;
            // 注文確定
            dataString = await completeOrder(replyToken, userkey, 1);
            break;

        // カード
        case "card":
            // メッセージ送付あり
            sendFlg = true;
            // 戻り禁止
            if (processId > 7) {
                // オペレータ対応
                dataString = JSON.stringify({
                    replyToken: replyToken, // 返信トークン
                    messages: [
                        {
                            type: "text",
                            text: "不正な操作です。",
                        },
                    ],
                });
                // プロセスID
                processId = 99;
                break;
            }
            // プロセスID
            processId = 8;
            // カラム
            const transColumns = ["transactionkey"];
            // 確定注文抽出
            const transData = await selectDB(
                "transaction",
                "userkey",
                userkey,
                transColumns,
                "id"
            );
            // エラー
            if (transData == "error") {
                console.log(`transaction search error`);
            }
            // オペレータ対応
            dataString = JSON.stringify({
                replyToken: replyToken, // 返信トークン
                messages: [
                    {
                        type: "text",
                        text: `下記URLをタップして決済画面に移動して下さい。\nhttps://card.suijinclub.com/card?key=${transData[0].transactionkey}`,
                    },
                ],
            });
            break;

        // デフォルト
        default:
            // メッセージ送付なし
            sendFlg = false;
            // メッセージ
            const tmpMessage = req.body.events[0].message.text;
            // カラム
            const userData2Columns = ["customerno"];
            // 顧客番号抽出
            const userData2 = await selectDB(
                "lineuser",
                "userid",
                userId,
                userData2Columns,
                "id"
            );

            // エラー
            if (userData2 == "error") {
                console.log(`product search error`);
            }
            // 顧客番号
            const customerNo2 = userData2[0].customerno;

            // 「商品ID」を含む
            if (tmpMessage.includes("商品ID")) {
                // メッセージ送付あり
                sendFlg = true;

                // 戻り禁止
                if (processId > 3 || orderFlg) {
                    // オペレータ対応
                    dataString = JSON.stringify({
                        replyToken: replyToken, // 返信トークン
                        messages: [
                            {
                                type: "text",
                                text: "不正な操作です。",
                            },
                        ],
                    });
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
                const tmpCategoryId = tmpArray1[1];

                // 注文カラム
                const orderColumns = ["id"];
                // 対象注文下書きID抽出
                const orderData = await selectDoubleDB(
                    "draftorder",
                    "userkey",
                    userkey,
                    "tmpcategoryid",
                    tmpCategoryId,
                    orderColumns,
                    "id",
                    true
                );

                // product
                const product2Columns = ["id", "categoryid", "categoryname"];
                // カテゴリID抽出
                const product2 = await selectDB(
                    "product",
                    "categoryid",
                    tmpCategoryId,
                    product2Columns,
                    "id"
                );

                // エラー
                if (product2 == "error") {
                    console.log(`product search error`);
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
                        orderData[0].id
                    );
                }

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
                                        text: `注文数:${categoryid}:6`,
                                    },
                                    {
                                        type: "message",
                                        label: "12本", // 本数単価（合計）
                                        text: `注文数:${categoryid}:12`,
                                    },
                                    {
                                        type: "message",
                                        label: "24本", // 本数単価（合計）
                                        text: `注文数:${categoryid}:24`,
                                    },
                                    {
                                        type: "message",
                                        label: "36本", // 本数単価（合計）
                                        text: `注文数:${categoryid}:36`,
                                    },
                                ],
                            },
                        },
                    ],
                });

                // 「注文数」を含む
            } else if (tmpMessage.includes("注文数")) {
                // メッセージ送付あり
                sendFlg = true;
                // 戻り禁止
                if (processId > 3 || !orderFlg) {
                    // オペレータ対応
                    dataString = JSON.stringify({
                        replyToken: replyToken, // 返信トークン
                        messages: [
                            {
                                type: "text",
                                text: "不正な操作です。",
                            },
                        ],
                    });
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
                const tmpCategoryId = tmpArray2[1];
                // 注文数量
                const tmpAmount = Number(tmpArray2[2]);

                // 注文下書き更新
                await updateDoubleDB(
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

    // メッセージ送付時
    if (sendFlg) {
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
    let tmpText = "";
    // 単位
    let unitStr = "";
    // 最終価格
    let lastTotalPrice = 0;
    // カウンタ
    let counter = 0;

    // draftorder
    const order1Columns = [
        "tmpcategoryid",
        "product_id",
        "quantity",
    ];
    // 注文下書きから抽出
    const draftData1 = await selectDB(
        "draftorder",
        "userkey",
        key,
        order1Columns,
        "id",
        true
    );

    // エラー
    if (draftData1 == "error") {
       console.log(`draftorder search error`);
    }

    // 全Promiseを待機
    await Promise.all(
        // 注文データ内ループ
        draftData1.map(async (od2) => {
            // フラグオン
            if (flg) {
                // product6
                const product6Columns = ["categoryid", "price", "categoryname"];
                // 商品抽出
                const product6 = await selectDB(
                    "product",
                    "productid",
                    Number(od2.product_id),
                    product6Columns,
                    "id"
                );
                // エラー
                if (product6 == "error") {
                   console.log(`product search error`);
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
                } else {
                    tmpRet = "\n";
                }

                // 該当カテゴリ名あり
                if (product6[0].categoryname) {
                    // テキスト連結
                    tmpText += `${tmpRet}${product6[0].categoryname.slice(0, 11)}x${od2.quantity}${unitStr}:${totalprice.toLocaleString()}円`;
                }
                
            } else {
                // product7
                const product7Columns = [
                    "categoryname",
                    "categoryid",
                ];
                // 商品抽出
                const product7 = await selectDB(
                    "product",
                    "categoryid",
                    Number(od2.tmpcategoryid),
                    product7Columns,
                    "id"
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
                } else {
                    tmpRet = "\n";
                }
                // テキスト連結
                if (product7[0].categoryname) {
                    tmpText += `${tmpRet}${product7[0].categoryname.slice(0, 11)}:${od2.quantity}${unitStr}`;
                }
            }
            // カウンタ加算
            counter++;
        })
    );

    // 最終注文内容
    let finalStr;

    // 最終
    if (flg) {
        // テキスト確定
        finalStr = `${tmpText}\n送料: ${SHIPMENTFEE}円\n合計金額: ${(lastTotalPrice + SHIPMENTFEE).toLocaleString()}円`;
    } else {
        // そのまま
        finalStr = tmpText;
    }
    // 注文内容を返す
    return finalStr;
}

// 注文リスト作成
const updateOrder = (userKey) => {
    return new Promise(async (resolve, reject) => {
        try {
            // draftData2
            const order2Columns = ["id", "tmpcategoryid", "quantity"];
            // 下書き注文抽出
            const draftData2 = await selectDB(
                "draftorder",
                "userkey",
                userKey,
                order2Columns,
                "id",
                true
            );

            // エラー
            if (draftData2 == "error") {
                console.log(`draftorder search error`);
                reject();
            }

            // 一時合計数量
            let tmpamount = 0;
            // 合計金額
            draftData2.map(async (od) => {
                tmpamount += od.quantity;
            });

            // 合計数量
            let totalamount = 0;

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
                    // product3
                    const product3Columns = ["amount"];
                    // 商品ID抽出
                    const product3 = await selectDB(
                        "product",
                        "categoryid",
                        categoryId,
                        product3Columns,
                        "id"
                    );

                    // エラー
                    if (product3 == "error") {
                       console.log(`product search error`);
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
                    // product5
                    const product5Columns = ["productid", "price"];
                    // 商品抽出
                    const product5 = await selectDoubleDB(
                        "product",
                        "amount",
                        req.amount,
                        "categoryid",
                        req.categoryNo,
                        product5Columns,
                        "id",
                        false
                    );

                    // エラー
                    if (product5 == "error") {
                       console.log(`product search error`);
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
                        req.id
                    );
                    // 下書き注文更新
                    await updateDB(
                        "draftorder",
                        "total",
                        totalPrice,
                        "id",
                        req.id
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
const makeFinalPrice = (userKey) => {
    return new Promise(async (resolve, reject) => {
        try {
            // 顧客番号
            let customerno;
            // 総額
            let totalprice = 0;
            // 総注文数
            let totalquantity = 0;
            // 商品カラム
            const priceColumns = ['userid', 'customerno', 'total', 'quantity',];
            // 注文下書きから使用可能データを抽出
            const draftData2 = await selectDoubleDB(
                'draftorder',
                'userkey',
                userKey,
                'disabled',
                0,
                priceColumns,
                'id',
                true
            );

            // エラー
            if (draftData2 == 'error') {
               console.log(`product search error`);
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
                'completed',
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
                    "draftorder",
                    "transaction_id",
                    tmpReg.insertId,
                    "id",
                    od5.id
                );
            });
            // resolved
            resolve();

        } catch(e) {
            // エラー
            //console.log(e);
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
    // 商品リスト
    const productArray = await makeProductList(userID);

    if (productArray == 'error') {
        dataString = JSON.stringify({
            replyToken: replyToken, // 返信トークン
            messages: [
                {
                    type: "text",
                    text: "初回のご注文です。オペレータが対応します。\nアプリを閉じてお待ち下さい。",
                },
            ],
        });

    } else {
        // 注文確認
        if (flg) {
            titleString = "現在の注文内容\n(※確定→メッセージに「ok」）";
            fixedString = text;

            // 前回同注文
        } else {
            titleString = "前同注文";
            fixedString =
                "前回の注文商品から選択してください。商品名以外をタップすると最初に戻ります。";
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
                        defaultAction: {
                            type: "message",
                            label: "はじめに戻る",
                            text: "same",
                        },
                        thumbnailImageUrl:
                            "https://www.bodies.jp/wbodiesp/wp-content/uploads/2022/04/img_kiwako_column_photo_220407_01.png",
                        imageSize: "cover",
                        title: titleString,
                        text: fixedString,
                        actions: productArray,
                    },
                },
            ],
        });
    }
    return dataString;
};

// 商品リスト作成
const makeProductList = async(userID) => {
    // user1
    const user1Columns = ["customerno"];
    // LINEUSERから顧客番号抽出
    const userData1 = await selectDB(
        "lineuser",
        "userid",
        userID,
        user1Columns,
        "id"
    );

    // エラー
    if (userData1 == "error") {
       console.log(`product search error`);
    }
    // 顧客番号
    const customerNo1 = userData1[0].customerno;
    // 対象列
    const historyColumns = ["categoryid"];
    // 履歴からカテゴリIDを抽出
    const history = await selectDB(
        "ebisuorder",
        "customerno",
        customerNo1,
        historyColumns,
        "id"
    );

    // エラー
    if (history == "error") {
       console.log(`product search error`);
    }

    // 配列初期化
    let productArray = [];

    try {
        // 全promise待機
        await Promise.all(
            // 履歴ループ
            history.map(async (hs) => {
                // 対象列
                const product1Columns = ["categoryid", "categoryname"];
                // 商品抽出
                const product1 = await selectDB(
                    "product",
                    "categoryid",
                    hs.categoryid,
                    product1Columns,
                    "id"
                );

                // エラー
                if (product1 == "error") {
                console.log(`product search error`);
                }
                // カテゴリID
                const categoryId = product1[0].categoryid;

                // ソレイユ対応
                let tmpcategoryid;
                // ソレイユの場合
                if (categoryId == 239 || categoryId == 999) {
                    // ソレイユ価格対象顧客を抽出
                    const soleilData = await existDB(
                        "soleil",
                        "customerno",
                        customerNo1
                    );
                    // 該当配列
                    const arr = Object.entries(soleilData).shift();
                    // あり
                    if (arr[1] == "1") {
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
                if (categoryId) {
                    // 結果を配列に格納
                    productArray.push({
                        type: "message", // message
                        label: product1[0].categoryname, // 本数（単価用）
                        text: `商品ID:${tmpcategoryid.toString()}`, // メッセージ
                    });
                }
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

        // 結果を返す
        return productArray;
    }
}

// 注文完了
const completeOrder = (token, userKey, no) => {
    return new Promise(async (resolve, reject) => {
        try {
            // トランザクションを更新
            await updateDB('transaction', 'payment_id', no, 'userkey', userKey);
            await updateDB('transaction', 'completed', 1, 'userkey', userKey);

            // メッセージ
            const dataString = JSON.stringify({
                replyToken: token, // トークン
                messages: [
                    {
                        type: 'text',
                        text: 'ご注文ありがとうございました。',
                    },
                ],
            });
            // resolved
            resolve(dataString);

        } catch(e) {
            // エラー
            //console.log(e);
            reject(e);
        }
    });
};

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

// メッセージ送付
const sendMessage = (dtString) => {
    // ヘッダ
    const headers = {
        'Content-Type': 'application/json',
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
        res.on('data', (d) => {
            process.stdout.write(d);
        });
    });

    // データ送信
    request.write(dtString);
    request.end();
};

// ランダム文字列作成
const getSecureRandom = (size) => {
    // 一時文字列
    let result = "";
    // 生成文字リスト
    const str = "abcdefghijklmnopqrstuvwxyz0123456789";
    // 文字を順番に格納
    for (let i = 0; i < size; i++) {
        result += str.charAt(Math.floor(Math.random() * str.length));
    }
    return result;
};

// - database operation
// * exist or not
// select from database
const existDB = (table, column, value) => {
    return new Promise(async (resolve, reject) => {
        try {
            // query
            await myDB.doInquiry(
                'SELECT COUNT (*) FROM ?? WHERE ?? = ? LIMIT 1',
                [table, column, value]
            );

            // resolve
            resolve(myDB.getValue[0]);

        } catch (e) {
            // error
            reject(e);
        }
    });
};

// * select
// select from database
const selectDB = (table, column, values, field, order, flg = false) => {
    return new Promise(async (resolve, reject) => {
        try {
            // if normal mode
            if (!flg) {
                // query
                await myDB.doInquiry(
                    'SELECT ?? FROM ?? WHERE ?? IN (?) ORDER BY ??',
                    [field, table, column, values, order]
                );

            // if recent mode
            } else {
                // query
                await myDB.doInquiry(
                    'SELECT ?? FROM ?? WHERE ?? IN (?) AND ?? IN (?) AND ?? IN (?) AND ?? > date(current_timestamp - interval 1 day) ORDER BY ??',
                    [field, table, column, values, 'completed', 0, 'disabled', 0, 'created_at', order]
                );
            }
            // resolve
            resolve(myDB.getValue);

        } catch (e) {
            // error
            reject(e);
        }
    });
};

// select on multiple condition
const selectDoubleDB = (table, column1, value1, column2, value2, field, order, flg) => {
    return new Promise(async (resolve, reject) => {
        try {
            // if normal mode
            if (!flg) {
                // query
                await myDB.doInquiry(
                    'SELECT ?? FROM ?? WHERE ?? IN (?) AND ?? IN (?) ORDER BY ??',
                    [field, table, column1, value1, column2, value2, order]
                );

            // if recent mode
            } else {
                // query
                await myDB.doInquiry(
                    'SELECT ?? FROM ?? WHERE ?? IN (?) AND ?? IN (?) AND ?? IN (?) AND ?? IN (?) AND ?? > date(current_timestamp - interval 1 day) ORDER BY ??',
                    [field, table, column1, value1, column2, value2, 'completed', 0, 'disabled', 0, 'created_at', order]
                );
            }
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
const updateDB = (table, setcol, setval, selcol, selval) => {
    return new Promise(async (resolve, reject) => {
        try {
            // query
            await myDB.doInquiry('UPDATE ?? SET ?? = ? WHERE ?? = ?', [table, setcol, setval, selcol, selval]);
            // resolve
            resolve();

        } catch (e) {
            // error
            reject(e);
        }
    });
};

// update data
const updateDoubleDB = (table, setcol, setval, selcol1, selval1, selcol2, selval2) => {
    return new Promise(async (resolve, reject) => {
        try {
            // query
            await myDB.doInquiry(
                'UPDATE ?? SET ?? = ? WHERE ?? = ? AND ?? = ?',
                [table, setcol, setval, selcol1, selval1, selcol2, selval2]
            );
            // resolve
            resolve();
        } catch (e) {
            // error
            reject(e);
        }
    });
};
